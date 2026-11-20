import { test, expect } from "@playwright/test";
import { fillGuestContact } from "../helpers/guest";
import fs from "fs";
import path from "path";
import { Pool } from "pg";

/**
 * Spécification : Tests de non-régression > Public > Options par chambre
 * ADR-0010 : une option réservée à certaines chambres n'est proposée (et acceptée)
 * * que pour elles. Chambre API Test + une chambre « Suite » créée ici. Séjours J+1420…
 */

const ctx = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "e2e", ".auth", "test-context.json"), "utf-8"),
) as { tenantId: string; apiRoomId: string };

const TAG = `xq${Date.now().toString(36).slice(-6)}`;
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const day = (n: number) => new Date(Date.now() + n * 86400000).toISOString().split("T")[0];
let suiteId = "";

async function insertExtra(label: string, roomIds: string[] = []) {
  const { rows } = await pool.query(
    `INSERT INTO extras (tenant_id, label, price, unit, room_ids) VALUES ($1, $2, '10', 'per_stay', $3) RETURNING id`,
    [ctx.tenantId, `${label} ${TAG}`, roomIds],
  );
  return rows[0].id as string;
}

async function cleanup() {
  await pool.query("DELETE FROM bookings WHERE guest_email LIKE $1", [`%@${TAG}.example`]);
  await pool.query("DELETE FROM extras WHERE label LIKE $1", [`%${TAG}%`]);
  await pool.query("DELETE FROM rooms WHERE tenant_id = $1 AND slug ~ '-xq[0-9a-z]{6}$'", [ctx.tenantId]);
}

test.beforeAll(async () => {
  await cleanup();
  const { rows } = await pool.query(
    `INSERT INTO rooms (tenant_id, property_id, name, slug, price_per_night, capacity)
     SELECT tenant_id, property_id, $1, $2, '100.00', 2 FROM rooms WHERE id = $3 RETURNING id`,
    [`Suite ${TAG}`, `suite-${TAG}`, ctx.apiRoomId],
  );
  suiteId = rows[0].id;
});
test.afterAll(async () => {
  await cleanup();
  await pool.end();
});

test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders({
    "x-forwarded-for": `10.45.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`,
  });
});

test.describe("Public — Options par chambre", () => {
  test("option de la Suite : proposée sur la Suite, absente ailleurs ; option pour tous : partout", async ({ page }) => {
    await insertExtra("Jacuzzi", [suiteId]);
    await insertExtra("Linge");
    await page.goto(`/reserver/${suiteId}`);
    await expect(page.getByTestId("booking-extras")).toContainText(`Jacuzzi ${TAG}`);
    await expect(page.getByTestId("booking-extras")).toContainText(`Linge ${TAG}`);
    await page.goto(`/reserver/${ctx.apiRoomId}`);
    await expect(page.getByTestId("booking-extras")).toContainText(`Linge ${TAG}`);
    await expect(page.getByText(`Jacuzzi ${TAG}`)).toHaveCount(0);
  });

  test("option de la Suite injectée sur l'autre chambre : refusée, rien en base", async ({ page }) => {
    const extraId = await insertExtra("Ailleurs", [suiteId]);
    const email = `injecte@${TAG}.example`;
    await page.goto(`/reserver/${ctx.apiRoomId}`);
    await page.waitForLoadState("networkidle");
    await expect(async () => {
      await page.fill("#checkIn", day(1420));
      await page.fill("#checkOut", day(1422));
      await expect(page.locator('[name="checkIn"]')).toHaveValue(day(1420), { timeout: 500 });
    }).toPass({ timeout: 10_000 });
    await page.fill("#guestCount", "1");
    await page.locator("#guestCount").blur();
    await expect(page.getByText("Disponible", { exact: true })).toBeVisible({ timeout: 8000 });
    await fillGuestContact(page, { lastName: "Injecte", email });
    await page.locator("form").evaluate((f: HTMLFormElement, v) => {
      const i = document.createElement("input");
      i.type = "hidden";
      i.name = "extraIds";
      i.value = v;
      f.appendChild(i);
    }, extraId);
    await page.getByTestId("booking-submit").click();
    await expect(page.getByTestId("booking-error")).toContainText("option choisie n'est plus proposée");
    expect((await pool.query("SELECT 1 FROM bookings WHERE guest_email = $1", [email])).rowCount).toBe(0);
  });
});
