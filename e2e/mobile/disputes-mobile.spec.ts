import { test, expect, type Page } from "@playwright/test";
import fs from "fs";
import path from "path";
import { Pool } from "pg";
import { deleteOrphanDossiers } from "../helpers/dossier";
import { startFakeStripe, type FakeStripe } from "../helpers/fake-stripe";

/**
 * Litiges dans l'admin installé sur téléphone (360 px, jamais page.reload()) : bandeau et carte
 * du litige sur la fiche Dossier, formulaire de réponse sans débordement, cibles tactiles ≥ 40 px,
 * brouillon puis envoi confirmé sans recharger.
 */

const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL ?? "admin@test.maresa";
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD ?? "password";
const ctx = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "e2e", ".auth", "test-context.json"), "utf-8"),
) as { tenantId: string; apiRoomId: string };

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const STAMP = Date.now().toString(36);
const EMAIL = `disputes-mobile-${STAMP}@example.com`;
let stripe: FakeStripe;
let accountBefore: string | null;

test.use({ viewport: { width: 360, height: 760 } });

test.beforeAll(async () => {
  stripe = await startFakeStripe();
  accountBefore = (await pool.query("SELECT stripe_account_id FROM tenants WHERE id = $1", [ctx.tenantId])).rows[0].stripe_account_id;
  await pool.query("UPDATE tenants SET stripe_account_id = 'acct_test_e2e_main' WHERE id = $1", [ctx.tenantId]);
});

test.afterAll(async () => {
  await stripe.close();
  await pool.query("UPDATE tenants SET stripe_account_id = $2 WHERE id = $1", [ctx.tenantId, accountBefore]);
  const { rows } = await pool.query("SELECT id FROM dossiers WHERE guest_email = $1", [EMAIL]);
  const ids = rows.map((r) => r.id);
  await pool.query("DELETE FROM disputes WHERE dossier_id = ANY($1::uuid[])", [ids]);
  await pool.query("DELETE FROM payments WHERE dossier_id = ANY($1::uuid[])", [ids]);
  await pool.query("DELETE FROM bookings WHERE dossier_id = ANY($1::uuid[])", [ids]);
  await pool.query("DELETE FROM dossiers WHERE id = ANY($1::uuid[])", [ids]);
  await deleteOrphanDossiers(pool);
  await pool.end();
});

async function login(page: Page) {
  await page.goto("/login");
  await page.fill('[name="email"]', ADMIN_EMAIL);
  await page.fill('[name="password"]', ADMIN_PASSWORD);
  await page.click('[type="submit"]');
  await expect(page).toHaveURL(/\/admin$/);
}

const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test("téléphone 360 px : carte du litige et formulaire de réponse lisibles, brouillon puis envoi sans recharger", async ({ page }) => {
  test.setTimeout(60000);
  const name = `Famille Martin-Dupont-Lefebvre ${STAMP}`;
  const dossierId = (
    await pool.query(
      `INSERT INTO dossiers (tenant_id, check_in, check_out, guest_name, guest_email, accepted_cancellation_text, terms_accepted_at)
       VALUES ($1, '2036-08-04', '2036-08-07', $2, $3, $4, now() - interval '30 days') RETURNING id`,
      [ctx.tenantId, name, EMAIL, `Annulation gratuite jusqu'à 7 jours avant l'arrivée. ${"Texte long ".repeat(40)}`],
    )
  ).rows[0].id as string;
  await pool.query(
    `INSERT INTO bookings (tenant_id, dossier_id, room_id, check_in, check_out, total_price, status, guest_name, guest_email, guest_count, source)
     VALUES ($1, $2, $3, '2036-08-04', '2036-08-07', '450.00', 'confirmed', $4, $5, 2, 'direct')`,
    [ctx.tenantId, dossierId, ctx.apiRoomId, name, EMAIL],
  );
  const paymentId = (
    await pool.query(
      `INSERT INTO payments (tenant_id, dossier_id, stripe_session_id, stripe_payment_id, amount, currency, status)
       VALUES ($1, $2, $3, $4, '450.00', 'eur', 'paid') RETURNING id`,
      [ctx.tenantId, dossierId, `cs_test_disputes_mobile_${STAMP}`, `pi_test_disputes_mobile_${STAMP}`],
    )
  ).rows[0].id;
  await pool.query(
    `INSERT INTO disputes (tenant_id, dossier_id, payment_id, stripe_dispute_id, amount, reason, status, evidence_due_by)
     VALUES ($1, $2, $3, $4, '450.00', 'credit_not_processed', 'needs_response', now() + interval '12 days')`,
    [ctx.tenantId, dossierId, paymentId, `dp_mobile_${STAMP}`],
  );

  await login(page);
  await page.goto(`/admin/dossiers/${dossierId}`);
  await expect(page.locator("[data-dispute-banner]")).toContainText("Litige en cours : 450 €");
  const card = page.locator("[data-dispute-card]");
  for (const el of [card.locator("[data-dispute-respond]"), card.getByRole("button", { name: "Accepter le litige" })]) {
    const box = (await el.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(40);
    expect(box.x + box.width).toBeLessThanOrEqual(360);
  }
  expect(await overflow(page)).toBeLessThanOrEqual(0);

  await card.locator("[data-dispute-respond]").click();
  await expect(page.locator("[data-dispute-form]")).toBeVisible();
  for (const t of await page.locator("[data-dispute-form] textarea").all()) {
    const box = (await t.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(360);
  }
  expect(await overflow(page)).toBeLessThanOrEqual(0);

  await page.locator('[data-evidence="refund_refusal_explanation"]').fill("Le voyageur a annulé hors délai.");
  const draft = page.locator("[data-dispute-draft]");
  await draft.scrollIntoViewIfNeeded();
  expect((await draft.boundingBox())!.height).toBeGreaterThanOrEqual(40);
  await draft.click();
  await expect(page.locator("[data-dispute-saved]")).toBeVisible();

  await page.locator("[data-dispute-send]").click();
  const dialog = page.locator("dialog[open]");
  const box = (await dialog.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(360);
  await dialog.locator("[data-dispute-confirm]").click();
  await expect(page.locator("[data-dispute-flash]")).toContainText("Réponse envoyée à la banque");
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  expect(stripe.disputes.filter((d) => d.id === `dp_mobile_${STAMP}`).map((d) => d.params.submit)).toEqual(["false", "true"]);
});
