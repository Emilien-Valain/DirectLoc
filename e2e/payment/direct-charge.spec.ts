import fs from "fs";
import path from "path";
import { Pool } from "pg";
import { test, expect, type Page } from "@playwright/test";
import { fd } from "../helpers/dates";
import { fillGuestContact } from "../helpers/guest";
import { startFakeStripe, type FakeStripe } from "../helpers/fake-stripe";

/**
 * Spécification : Tests de non-régression > Paiement > Direct charge (réservation d'une chambre).
 * Un tenant non démo sans compte Stripe connecté ne peut pas encaisser en ligne : jamais de session
 * sur le compte plateforme. Avec compte : session créée SUR ce compte (en-tête Stripe-Account).
 * Démo : session sur la plateforme (pas d'en-tête), en mode test. Le multi-chambres est couvert
 * dans e2e/public/dossier-booking.spec.ts.
 */

const ctx = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "e2e", ".auth", "test-context.json"), "utf-8"),
) as { tenantId: string; apiRoomId: string };

const IN = fd("2026-12-07");
const OUT = fd("2026-12-09");
const NOT_ENABLED = "Le paiement en ligne n'est pas encore activé pour cet établissement. Contactez-le directement pour réserver.";

let pool: Pool;
let stripe: FakeStripe;

test.beforeAll(async () => {
  pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  stripe = await startFakeStripe();
});
test.afterAll(async () => {
  await stripe.close();
  await pool.end();
});
test.beforeEach(async ({ page }) => {
  stripe.sessions.length = 0;
  await page.setExtraHTTPHeaders({
    "x-forwarded-for": `10.77.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`,
  });
});

async function submit(page: Page, roomId: string, email: string, base = "") {
  await page.goto(`${base}/reserver/${roomId}?checkIn=${IN}&checkOut=${OUT}`);
  await page.waitForLoadState("networkidle");
  await expect(page.getByText("Disponible", { exact: true })).toBeVisible({ timeout: 8000 });
  await fillGuestContact(page, { lastName: "Direct", email });
  await page.getByTestId("booking-submit").click();
}

async function cleanup(email: string) {
  await pool.query("DELETE FROM payments WHERE dossier_id IN (SELECT dossier_id FROM bookings WHERE guest_email = $1)", [email]);
  await pool.query("DELETE FROM bookings WHERE guest_email = $1", [email]);
  await pool.query("DELETE FROM dossiers WHERE guest_email = $1", [email]);
}

const count = async (email: string) =>
  (await pool.query(
    "SELECT (SELECT count(*) FROM bookings WHERE guest_email = $1)::int AS b, (SELECT count(*) FROM dossiers WHERE guest_email = $1)::int AS d",
    [email],
  )).rows[0];

test.describe("Paiement — direct charge, une chambre", () => {
  test("tenant avec compte connecté : session créée avec l'en-tête Stripe-Account = son compte", async ({ page }) => {
    const email = `direct-ok-${Date.now()}@example.com`;
    try {
      await submit(page, ctx.apiRoomId, email);
      await expect(page).toHaveURL(/\/reserver\/confirmation\?session_id=cs_test_fake_/, { timeout: 15_000 });
      expect(stripe.sessions).toHaveLength(1);
      expect(stripe.sessions[0].stripeAccount).toBe("acct_test_e2e_main");
    } finally {
      await cleanup(email);
    }
  });

  test("tenant non démo sans compte : aucune session Stripe, rien gardé, message dédié", async ({ page }) => {
    const email = `direct-none-${Date.now()}@example.com`;
    const { rows } = await pool.query("SELECT stripe_account_id FROM tenants WHERE id = $1", [ctx.tenantId]);
    await pool.query("UPDATE tenants SET stripe_account_id = NULL WHERE id = $1", [ctx.tenantId]);
    try {
      await submit(page, ctx.apiRoomId, email);
      await expect(page.getByTestId("booking-error")).toContainText(NOT_ENABLED);
      await expect(page.getByTestId("booking-error")).not.toContainText("momentanément");
      await expect(page).toHaveURL(new RegExp(`/reserver/${ctx.apiRoomId}`));
      expect(stripe.sessions).toHaveLength(0);
      expect(await count(email)).toEqual({ b: 0, d: 0 });
    } finally {
      await pool.query("UPDATE tenants SET stripe_account_id = $2 WHERE id = $1", [ctx.tenantId, rows[0].stripe_account_id]);
      await cleanup(email);
    }
  });

  test("compte vide (chaîne vide) : traité comme absent", async ({ page }) => {
    const email = `direct-empty-${Date.now()}@example.com`;
    const { rows } = await pool.query("SELECT stripe_account_id FROM tenants WHERE id = $1", [ctx.tenantId]);
    await pool.query("UPDATE tenants SET stripe_account_id = '' WHERE id = $1", [ctx.tenantId]);
    try {
      await submit(page, ctx.apiRoomId, email);
      await expect(page.getByTestId("booking-error")).toContainText(NOT_ENABLED);
      expect(stripe.sessions).toHaveLength(0);
      expect(await count(email)).toEqual({ b: 0, d: 0 });
    } finally {
      await pool.query("UPDATE tenants SET stripe_account_id = $2 WHERE id = $1", [ctx.tenantId, rows[0].stripe_account_id]);
      await cleanup(email);
    }
  });

  test("démo : session sur le compte plateforme (aucun en-tête Stripe-Account), même avec un compte en base", async ({ page }) => {
    const email = `direct-demo-${Date.now()}@example.com`;
    const existing = await pool.query("SELECT id, stripe_account_id FROM tenants WHERE slug = 'demo-tenant'");
    let demoId: string = existing.rows[0]?.id;
    const created = !demoId;
    if (created) demoId = (await pool.query("INSERT INTO tenants (name, slug) VALUES ('Hôtel Démo', 'demo-tenant') RETURNING id")).rows[0].id;
    // Compte posé exprès : la démo doit l'ignorer.
    await pool.query("UPDATE tenants SET stripe_account_id = 'acct_test_e2e_demo_ignored' WHERE id = $1", [demoId]);
    const propertyId = (await pool.query("INSERT INTO properties (tenant_id, name) VALUES ($1, 'Direct charge') RETURNING id", [demoId])).rows[0].id;
    const roomId = (
      await pool.query(
        `INSERT INTO rooms (tenant_id, property_id, name, slug, price_per_night, capacity)
         VALUES ($1, $2, 'Chambre direct charge', $3, '100.00', 2) RETURNING id`,
        [demoId, propertyId, `direct-charge-${Date.now()}`],
      )
    ).rows[0].id;
    try {
      await submit(page, roomId, email, "http://demo-tenant.localhost:3001");
      await expect(page).toHaveURL(/\/reserver\/confirmation\?session_id=cs_test_fake_/, { timeout: 15_000 });
      expect(stripe.sessions).toHaveLength(1);
      expect(stripe.sessions[0].stripeAccount).toBeUndefined();
    } finally {
      await cleanup(email);
      await pool.query("DELETE FROM rooms WHERE id = $1", [roomId]);
      await pool.query("DELETE FROM properties WHERE id = $1", [propertyId]);
      if (created) await pool.query("DELETE FROM tenants WHERE id = $1", [demoId]);
      else await pool.query("UPDATE tenants SET stripe_account_id = $2 WHERE id = $1", [demoId, existing.rows[0].stripe_account_id]);
    }
  });
});
