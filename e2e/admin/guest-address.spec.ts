import { test, expect } from "@playwright/test";
import fs from "fs";
import path from "path";
import { Pool } from "pg";

/**
 * Adresse et pays du client (site public) : affichés échappés dans la fiche réservation et
 * dans le PDF. Prénom et nom séparés : repris dans le formulaire de modification.
 */

const ctx = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "e2e", ".auth", "test-context.json"), "utf-8"),
) as { tenantId: string; apiRoomId: string };

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const EMAIL = `adresse-${Date.now()}@example.com`;

test.afterAll(async () => {
  await pool.query("DELETE FROM bookings WHERE guest_email = $1", [EMAIL]);
  await pool.end();
});

async function insert(address: string | null, extra: { country?: string; first?: string; last?: string } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO bookings (tenant_id, room_id, check_in, check_out, total_price, status, guest_name, guest_first_name, guest_last_name, guest_email, guest_phone, guest_address, guest_country, guest_count, source)
     VALUES ($1, $2, '2033-03-01', '2033-03-03', '200.00', 'confirmed', 'Marie Curie', $5, $6, $3, '0601020304', $4, $7, 1, 'direct') RETURNING id`,
    [ctx.tenantId, ctx.apiRoomId, EMAIL, address, extra.first ?? "", extra.last ?? "", extra.country ?? null],
  );
  return rows[0].id as string;
}

test.describe("Admin — adresse du client", () => {
  test("affichée dans la fiche ; XSS échappé ; PDF généré même avec une adresse très longue", async ({ page }) => {
    let dialog = false;
    page.on("dialog", () => (dialog = true));
    const long = `<script>alert(1)</script> ${"12 rue très longue ".repeat(15)}`.slice(0, 300);
    const id = await insert(long);
    await page.goto(`/admin/reservations/${id}`);
    await expect(page.getByText("<script>alert(1)</script>", { exact: false })).toBeVisible();
    expect(dialog).toBe(false);
    const pdf = await page.request.get(`/api/admin/reservations/${id}/pdf`);
    expect(pdf.status()).toBe(200);
  });

  test("réservation sans adresse ni pays (saisie manuelle) : pas de ligne Adresse ni Pays", async ({ page }) => {
    const id = await insert(null);
    await page.goto(`/admin/reservations/${id}`);
    await expect(page.getByText("Marie Curie").first()).toBeVisible();
    await expect(page.getByText("Adresse", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Pays", { exact: true })).toHaveCount(0);
  });

  test("pays affiché en toutes lettres ; code inconnu affiché tel quel, échappé ; PDF généré", async ({ page }) => {
    const id = await insert("Hauptstraße 1, 10115 Berlin", { country: "DE" });
    await page.goto(`/admin/reservations/${id}`);
    await expect(page.getByText("Allemagne", { exact: true })).toBeVisible();
    expect((await page.request.get(`/api/admin/reservations/${id}/pdf`)).status()).toBe(200);

    let dialog = false;
    page.on("dialog", () => (dialog = true));
    const odd = await insert("x 12345", { country: "<img src=x onerror=alert(1)>" });
    await page.goto(`/admin/reservations/${odd}`);
    await expect(page.getByText("<img src=x onerror=alert(1)>")).toBeVisible();
    expect(dialog).toBe(false);
  });

  test("modifier : prénom et nom repris séparément ; ancienne ligne sans prénom/nom découpée au premier espace", async ({ page }) => {
    const split = await insert(null, { first: "Marie Anne", last: "Curie" });
    await page.goto(`/admin/reservations/${split}/modifier`);
    await expect(page.locator('[name="guestFirstName"]')).toHaveValue("Marie Anne");
    await expect(page.locator('[name="guestLastName"]')).toHaveValue("Curie");

    const legacy = await insert(null);
    await page.goto(`/admin/reservations/${legacy}/modifier`);
    await expect(page.locator('[name="guestFirstName"]')).toHaveValue("Marie");
    await expect(page.locator('[name="guestLastName"]')).toHaveValue("Curie");
  });
});
