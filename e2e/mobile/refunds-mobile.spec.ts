import { test, expect, type Page } from "@playwright/test";
import fs from "fs";
import path from "path";
import { Pool } from "pg";
import { deleteOrphanDossiers } from "../helpers/dossier";
import { startFakeStripe, type FakeStripe } from "../helpers/fake-stripe";

/**
 * Remboursements dans l'admin installé sur téléphone (360 px, jamais page.reload()) :
 * dialog « Rembourser » et case « Rembourser X € » du dialog d'annulation, sans débordement,
 * cibles tactiles ≥ 40 px, remboursement abouti sans recharger.
 */

const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL ?? "admin@test.maresa";
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD ?? "password";
const ctx = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "e2e", ".auth", "test-context.json"), "utf-8"),
) as { tenantId: string; apiRoomId: string };

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const STAMP = Date.now().toString(36);
const EMAIL = `refunds-mobile-${STAMP}@example.com`;
let roomId: string;
let stripe: FakeStripe;

test.use({ viewport: { width: 360, height: 760 } });

test.beforeAll(async () => {
  stripe = await startFakeStripe();
  roomId = (
    await pool.query(
      `INSERT INTO rooms (tenant_id, property_id, name, slug, price_per_night, capacity)
       SELECT tenant_id, property_id, $2, $3, '100.00', 4 FROM rooms WHERE id = $1 RETURNING id`,
      [ctx.apiRoomId, `Suite panoramique au très long nom ${STAMP}`, `refunds-mobile-${STAMP}`],
    )
  ).rows[0].id;
});

test.afterAll(async () => {
  await stripe.close();
  const { rows } = await pool.query("SELECT id FROM dossiers WHERE guest_email = $1", [EMAIL]);
  const ids = rows.map((r) => r.id);
  await pool.query("DELETE FROM refunds WHERE dossier_id = ANY($1::uuid[])", [ids]);
  await pool.query("DELETE FROM payments WHERE dossier_id = ANY($1::uuid[])", [ids]);
  await pool.query("DELETE FROM bookings WHERE dossier_id = ANY($1::uuid[])", [ids]);
  await pool.query("DELETE FROM dossiers WHERE id = ANY($1::uuid[])", [ids]);
  await pool.query("DELETE FROM rooms WHERE id = $1", [roomId]);
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

test("téléphone 360 px : dialog « Rembourser » et case du dialog d'annulation lisibles, remboursement sans recharger", async ({ page }) => {
  test.setTimeout(60000);
  const name = `Famille Martin-Dupont-Lefebvre ${STAMP}`;
  const dossierId = (
    await pool.query(
      `INSERT INTO dossiers (tenant_id, check_in, check_out, guest_name, guest_email, cancellation_level)
       VALUES ($1, '2036-08-04', '2036-08-07', $2, $3, 'moderate') RETURNING id`,
      [ctx.tenantId, name, EMAIL],
    )
  ).rows[0].id as string;
  await pool.query(
    `INSERT INTO bookings (tenant_id, dossier_id, room_id, check_in, check_out, total_price, status, guest_name, guest_email, guest_count, source)
     VALUES ($1, $2, $3, '2036-08-04', '2036-08-07', '450.00', 'confirmed', $4, $5, 2, 'direct')`,
    [ctx.tenantId, dossierId, roomId, name, EMAIL],
  );
  await pool.query(
    `INSERT INTO payments (tenant_id, dossier_id, stripe_session_id, stripe_payment_id, amount, currency, status)
     VALUES ($1, $2, $3, $4, '450.00', 'eur', 'paid')`,
    [ctx.tenantId, dossierId, `cs_test_refunds_mobile_${STAMP}`, `pi_test_refunds_mobile_${STAMP}`],
  );

  await login(page);
  await page.goto(`/admin/dossiers/${dossierId}`);

  // Case du dialog d'annulation : raccourcis lisibles, rien ne déborde ; on garde le séjour.
  await page.getByRole("button", { name: "Annuler tout le Dossier" }).click();
  const cancel = page.locator("dialog[open]");
  await expect(cancel.getByRole("checkbox", { name: /Rembourser/ })).toBeChecked();
  for (const b of await cancel.locator("[data-refund-shortcut]").all()) {
    const box = (await b.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(40);
    expect(box.x + box.width).toBeLessThanOrEqual(360);
  }
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await cancel.getByRole("button", { name: "Garder" }).click();

  // Dialog « Rembourser » : tient dans l'écran, le bouton reste atteignable, remboursement sans recharger.
  await page.locator("[data-refund-open]").click();
  const dialog = page.locator("dialog[data-refund-dialog][open]");
  const box = (await dialog.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(360);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await dialog.locator('input[name="amount"]').fill("45,50");
  const submit = dialog.locator("[data-refund-submit]");
  await submit.scrollIntoViewIfNeeded();
  expect((await submit.boundingBox())!.height).toBeGreaterThanOrEqual(40);
  await submit.click();
  await expect(page.locator("[data-refund-banner]")).toContainText(/Remboursement de 45,50\s€ effectué/);
  await expect(page.locator("[data-money-moves] li")).toHaveCount(2);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  expect(stripe.refunds.filter((r) => r.params["metadata[dossierId]"] === dossierId).map((r) => r.params.amount)).toEqual(["4550"]);
});
