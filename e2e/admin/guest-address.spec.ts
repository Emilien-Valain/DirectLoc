import { test, expect } from "@playwright/test";
import fs from "fs";
import path from "path";
import { Pool } from "pg";

/** Adresse du client (site public) : affichée échappée dans la fiche réservation et dans le PDF. */

const ctx = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "e2e", ".auth", "test-context.json"), "utf-8"),
) as { tenantId: string; apiRoomId: string };

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const EMAIL = `adresse-${Date.now()}@example.com`;

test.afterAll(async () => {
  await pool.query("DELETE FROM bookings WHERE guest_email = $1", [EMAIL]);
  await pool.end();
});

async function insert(address: string | null) {
  const { rows } = await pool.query(
    `INSERT INTO bookings (tenant_id, room_id, check_in, check_out, total_price, status, guest_name, guest_email, guest_phone, guest_address, guest_count, source)
     VALUES ($1, $2, '2033-03-01', '2033-03-03', '200.00', 'confirmed', 'Marie Curie', $3, '0601020304', $4, 1, 'direct') RETURNING id`,
    [ctx.tenantId, ctx.apiRoomId, EMAIL, address],
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

  test("réservation sans adresse (saisie manuelle) : pas de ligne Adresse", async ({ page }) => {
    const id = await insert(null);
    await page.goto(`/admin/reservations/${id}`);
    await expect(page.getByText("Marie Curie").first()).toBeVisible();
    await expect(page.getByText("Adresse", { exact: true })).toHaveCount(0);
  });
});
