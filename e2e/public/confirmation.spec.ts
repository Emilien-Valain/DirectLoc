import fs from "fs";
import path from "path";
import { Pool } from "pg";
import { deleteOrphanDossiers } from "../helpers/dossier";
import { test, expect } from "@playwright/test";
import { fd } from "../helpers/dates";

/**
 * Spécification : Tests de non-régression > Public > Page de confirmation
 * La page n'est accessible que via le session_id Stripe (success_url) :
 * un id de réservation seul ne doit jamais révéler la réservation d'un client.
 */

const ctx = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "e2e", ".auth", "test-context.json"), "utf-8"),
) as { tenantId: string; apiRoomId: string; rivalTenantId: string; rivalRoomId: string };

const RUN_ID = Date.now().toString(36);
const GUEST_NAME = `Client Confirmation ${RUN_ID}`;

test.use({ extraHTTPHeaders: { "x-forwarded-for": "10.10.0.7" } });

test.describe("Public — Page de confirmation", () => {
  let pool: Pool;
  const bookingIds: string[] = [];
  let bookingId: string;
  const sessionId = `cs_test_confirm_${RUN_ID}`;
  const rivalSessionId = `cs_test_confirm_rival_${RUN_ID}`;

  async function insertBooking(tenantId: string, roomId: string, stripeSessionId: string, status = "confirmed") {
    const { rows } = await pool.query(
      `WITH d AS (INSERT INTO dossiers (tenant_id, check_in, check_out, guest_name, guest_email) VALUES ($1, '2030-01-01', '2030-01-02', 'Dossier Test', 'dossier@example.com') RETURNING id)
     INSERT INTO bookings (tenant_id, room_id, check_in, check_out, total_price, status, guest_name, guest_email, guest_count, source, dossier_id)
       VALUES ($1, $2, $3, $4, '200.00', $6, $5, 'confirmation@test.com', 1, 'direct', (SELECT id FROM d))
       RETURNING id`,
      [tenantId, roomId, fd("2026-08-17"), fd("2026-08-19"), GUEST_NAME, status],
    );
    const id = rows[0].id as string;
    bookingIds.push(id);
    await pool.query(
      `INSERT INTO payments (tenant_id, dossier_id, stripe_session_id, amount, currency, status)
       VALUES ($1, (SELECT dossier_id FROM bookings WHERE id = $2), $3, '200.00', 'eur', 'succeeded')`,
      [tenantId, id, stripeSessionId],
    );
    return id;
  }

  test.beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    bookingId = await insertBooking(ctx.tenantId, ctx.apiRoomId, sessionId);
    await insertBooking(ctx.rivalTenantId, ctx.rivalRoomId, rivalSessionId);
  });

  test.afterAll(async () => {
    await pool.query("DELETE FROM payments WHERE dossier_id IN (SELECT dossier_id FROM bookings WHERE id = ANY($1::uuid[]))", [bookingIds]);
    await pool.query("DELETE FROM bookings WHERE id = ANY($1::uuid[])", [bookingIds]);
    await deleteOrphanDossiers(pool);
    await pool.end();
  });

  test("session_id Stripe valide → la confirmation s'affiche", async ({ page }) => {
    const res = await page.goto(`/reserver/confirmation?session_id=${sessionId}`);
    expect(res?.status()).toBe(200);
    await expect(page.getByText(GUEST_NAME)).toBeVisible();
  });

  test("réservation payée : bloc « Préparer votre arrivée » avec adresse, téléphone et itinéraire", async ({ page }) => {
    await page.goto(`/reserver/confirmation?session_id=${sessionId}`);
    const arrival = page.getByTestId("confirmation-arrival");
    await expect(arrival).toContainText("Préparer votre arrivée");
    await expect(arrival).toContainText("Bonnieux");
    await expect(arrival.getByRole("link", { name: "+33 4 90 00 00 00" })).toHaveAttribute("href", "tel:+33 4 90 00 00 00");
    // Coordonnées du tenant de test → itinéraire Google Maps vers ces coordonnées.
    await expect(arrival.getByRole("link", { name: "Voir l'itinéraire" })).toHaveAttribute(
      "href",
      /google\.com\/maps\/dir\/\?api=1&destination=43\.8233%2C5\.3076/,
    );
    await expect(page.getByRole("link", { name: "Retour à l'accueil" })).toBeVisible();
  });

  test("paiement en attente : la page se met à jour seule quand le webhook confirme", async ({ page }) => {
    const pendingSession = `cs_test_confirm_pending_${RUN_ID}`;
    const id = await insertBooking(ctx.tenantId, ctx.apiRoomId, pendingSession, "pending");
    await page.goto(`/reserver/confirmation?session_id=${pendingSession}`);
    await expect(page.getByText("Paiement en cours de vérification")).toBeVisible();
    await expect(page.getByTestId("pending-message")).toContainText("se met à jour toute seule");
    // Le webhook passe la réservation en confirmée : sans rechargement manuel, la page suit.
    await pool.query("UPDATE bookings SET status = 'confirmed' WHERE id = $1", [id]);
    await expect(page.getByText("Réservation confirmée")).toBeVisible({ timeout: 10_000 });
  });

  test("paiement en attente : pas encore de bloc d'arrivée", async ({ page }) => {
    const pendingSession = `cs_test_confirm_noarrival_${RUN_ID}`;
    await insertBooking(ctx.tenantId, ctx.apiRoomId, pendingSession, "pending");
    await page.goto(`/reserver/confirmation?session_id=${pendingSession}`);
    await expect(page.getByText("Paiement en cours de vérification")).toBeVisible();
    await expect(page.getByTestId("confirmation-arrival")).toHaveCount(0);
  });

  test("?bookingId=<id réel> → 404, les données du client ne fuient pas", async ({ request }) => {
    const res = await request.get(`/reserver/confirmation?bookingId=${bookingId}`);
    expect(res.status()).toBe(404);
    expect(await res.text()).not.toContain(GUEST_NAME);
  });

  test("?bookingId=abc (UUID malformé) → 404, jamais 500", async ({ request }) => {
    const res = await request.get("/reserver/confirmation?bookingId=abc");
    expect(res.status()).toBe(404);
  });

  test("session_id inconnu, vide, ou absent → 404", async ({ request }) => {
    for (const qs of ["?session_id=cs_inexistant", "?session_id=", ""]) {
      const res = await request.get(`/reserver/confirmation${qs}`);
      expect(res.status(), qs || "(sans paramètre)").toBe(404);
    }
  });

  test("session_id d'un autre tenant → 404 (isolation multi-tenant)", async ({ request }) => {
    const res = await request.get(`/reserver/confirmation?session_id=${rivalSessionId}`);
    expect(res.status()).toBe(404);
    expect(await res.text()).not.toContain(GUEST_NAME);
  });
});
