import { test, expect, type Page } from "@playwright/test";
import fs from "fs";
import path from "path";
import { Pool } from "pg";
import { deleteOrphanDossiers } from "../helpers/dossier";

/**
 * Fiche Dossier (ADR-0012) dans l'admin installé sur téléphone : 360 px de large,
 * sans rechargement (jamais page.reload() : l'app n'a ni barre d'adresse ni bouton recharger).
 */

const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL ?? "admin@test.maresa";
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD ?? "password";

const ctx = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "e2e", ".auth", "test-context.json"), "utf-8"),
) as { tenantId: string; apiRoomId: string };

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const STAMP = Date.now().toString(36);
const rooms: string[] = [];

test.use({ viewport: { width: 360, height: 760 } });

test.beforeAll(async () => {
  for (const n of [1, 2]) {
    const { rows } = await pool.query(
      `INSERT INTO rooms (tenant_id, property_id, name, slug, price_per_night, capacity)
       SELECT tenant_id, property_id, $2, $3, '100.00', 4 FROM rooms WHERE id = $1 RETURNING id`,
      [ctx.apiRoomId, `Suite familiale au très long nom ${n} ${STAMP}`, `dossier-mobile-${n}-${STAMP}`],
    );
    rooms.push(rows[0].id);
  }
});

test.afterAll(async () => {
  const { rows } = await pool.query("SELECT DISTINCT dossier_id FROM bookings WHERE room_id = ANY($1::uuid[])", [rooms]);
  const ids = rows.map((r) => r.dossier_id);
  await pool.query("DELETE FROM payments WHERE dossier_id = ANY($1::uuid[])", [ids]);
  await pool.query("DELETE FROM bookings WHERE dossier_id = ANY($1::uuid[])", [ids]);
  await pool.query("DELETE FROM dossiers WHERE id = ANY($1::uuid[])", [ids]);
  await pool.query("DELETE FROM rooms WHERE id = ANY($1::uuid[])", [rooms]);
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

test("fiche Dossier sur téléphone (360 px) : lisible sans défilement horizontal, annulation d'une chambre sans recharger", async ({ page }) => {
  test.setTimeout(60000);
  const name = `Famille Martin-Dupont-Lefebvre ${STAMP}`;
  const { rows } = await pool.query(
    `INSERT INTO dossiers (tenant_id, check_in, check_out, guest_name, guest_email, guest_phone)
     VALUES ($1, '2035-12-04', '2035-12-07', $2, 'une.adresse.email.vraiment.tres.longue@example.com', '06 12 34 56 78') RETURNING id`,
    [ctx.tenantId, name],
  );
  const dossierId = rows[0].id as string;
  const bookingIds: string[] = [];
  for (const [i, roomId] of rooms.entries()) {
    const res = await pool.query(
      `INSERT INTO bookings (tenant_id, dossier_id, room_id, check_in, check_out, total_price, status, guest_name, guest_email, guest_count, source, created_at)
       VALUES ($1, $2, $3, '2035-12-04', '2035-12-07', '300.00', 'confirmed', $4, 'une.adresse.email.vraiment.tres.longue@example.com', 3, 'manual', now() + ($5 || ' milliseconds')::interval) RETURNING id`,
      [ctx.tenantId, dossierId, roomId, name, String(i)],
    );
    bookingIds.push(res.rows[0].id);
  }

  await login(page);
  await page.goto(`/admin/dossiers/${dossierId}`);
  await expect(page.getByRole("heading", { name })).toBeVisible();
  await expect(page.locator("[data-dossier-room]")).toHaveCount(2);

  // Rien ne déborde à 360 px (noms longs, email long, boutons).
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  // Cibles tactiles confortables.
  for (const button of [
    page.locator(`[data-dossier-room="${bookingIds[1]}"]`).getByRole("button", { name: "Annuler cette chambre" }),
    page.locator(`[data-dossier-room="${bookingIds[1]}"]`).getByRole("link", { name: "Voir la réservation" }),
    page.getByRole("button", { name: "Annuler tout le Dossier" }),
  ]) {
    const box = await button.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(40);
    expect(box!.x + box!.width).toBeLessThanOrEqual(360);
  }

  // Annuler la 2e chambre : la fiche se met à jour seule, la 1re reste confirmée.
  await page.locator(`[data-dossier-room="${bookingIds[1]}"]`).getByRole("button", { name: "Annuler cette chambre" }).click();
  await page.locator("dialog[open] [data-confirm]").click();
  await expect(page).toHaveURL(/chambre-annulee=(1|sans-email)$/);
  await expect(page.getByText(/Chambre annulée et libérée|Annulation faite/)).toBeVisible();
  await expect(page.locator(`[data-dossier-room="${bookingIds[1]}"]`)).toContainText("Annulée");
  await expect(page.locator(`[data-dossier-room="${bookingIds[0]}"]`)).toContainText("Confirmée");
  const status = await pool.query("SELECT id, status FROM bookings WHERE dossier_id = $1", [dossierId]);
  expect(Object.fromEntries(status.rows.map((r) => [r.id, r.status]))).toEqual({
    [bookingIds[0]]: "confirmed",
    [bookingIds[1]]: "cancelled",
  });

  // Geste Retour vers la réservation puis le Dossier : toujours à jour, sans rechargement.
  await page.locator(`[data-dossier-room="${bookingIds[0]}"]`).getByRole("link", { name: "Voir la réservation" }).click();
  await expect(page.locator("[data-dossier-link]")).toBeVisible();
  await page.goBack();
  await expect(page.locator(`[data-dossier-room="${bookingIds[1]}"]`)).toContainText("Annulée");
});
