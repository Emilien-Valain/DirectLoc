import fs from "fs";
import path from "path";
import { Pool } from "pg";
import { test, expect } from "@playwright/test";
import { EXPECTED, parseCounts, seedNetworkActivity } from "../helpers/network-activity";

/**
 * Spécification : Tests de non-régression > Admin > Réseau : compteur du tableau de bord.
 * Issue `.scratch/reseau-voisins/issues/05-network-counter-and-monthly-report.md`.
 * envoyés = Renvois dont l'hôtel est l'envoyeur ; reçus = Renvois dont il est le Voisin ; réservations = Dossiers
 * confirmés attribués au réseau où il est l'envoyeur OU le receveur. Ce mois-ci (UTC) et au total, jamais de chiffre global.
 * Les chiffres sont comparés à une base lue avant l'amorçage (la base de test peut contenir d'autres Renvois).
 */
const ctx = JSON.parse(fs.readFileSync(path.join(process.cwd(), "e2e", ".auth", "test-context.json"), "utf-8")) as { tenantId: string; apiRoomId: string };
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
let seeded: Awaited<ReturnType<typeof seedNetworkActivity>> | null = null;

test.afterAll(async () => {
  await seeded?.cleanup();
  await pool.end();
});

const read = async (page: import("@playwright/test").Page) => ({
  month: parseCounts(await page.locator("[data-network-month]").innerText()),
  total: parseCounts(await page.locator("[data-network-total]").innerText()),
});

test("compteur : toujours affiché, cohérent avec les Renvois du tenant, sans compter ceux des autres", async ({ page }) => {
  await page.goto("/admin");
  await expect(page.locator("[data-network-counter]")).toBeVisible();
  const before = await read(page);
  expect(Number.isNaN(before.month.sent + before.total.bookings)).toBe(false);

  seeded = await seedNetworkActivity(pool, ctx);
  await page.goto("/admin");
  const after = await read(page);
  expect(after.month.sent - before.month.sent).toBe(EXPECTED.month.sent);
  expect(after.month.received - before.month.received).toBe(EXPECTED.month.received);
  expect(after.month.bookings - before.month.bookings).toBe(EXPECTED.month.bookings);
  // Total = ce mois-ci + le mois précédent (Renvoi envoyé du mois dernier).
  expect(after.total.sent - before.total.sent).toBe(EXPECTED.month.sent + EXPECTED.previous.sent);
  expect(after.total.received - before.total.received).toBe(EXPECTED.month.received);
  expect(after.total.bookings - before.total.bookings).toBe(EXPECTED.month.bookings);

  // Nettoyage : retour exact à la situation de départ (rien d'autre dans le compteur).
  await seeded.cleanup();
  seeded = null;
  await page.goto("/admin");
  expect(await read(page)).toEqual(before);
});

test("sans coordonnées GPS : avertissement à côté du compteur ; hors réseau (opérateur) : mention", async ({ page }) => {
  const { rows } = await pool.query("SELECT config FROM tenants WHERE id = $1", [ctx.tenantId]);
  const original = rows[0].config;
  try {
    await page.goto("/admin");
    await expect(page.getByTestId("network-counter-gps-warning")).toHaveCount(0);
    await expect(page.locator("[data-network-disabled]")).toHaveCount(0);

    const noGps = { ...original };
    delete noGps.latitude;
    delete noGps.longitude;
    await pool.query("UPDATE tenants SET config = $2::jsonb WHERE id = $1", [ctx.tenantId, JSON.stringify(noGps)]);
    await page.goto("/admin");
    await expect(page.getByTestId("network-counter-gps-warning")).toContainText("Sans position GPS");
    await expect(page.locator("[data-network-counter]")).toBeVisible(); // le compteur reste affiché

    await pool.query("UPDATE tenants SET config = $2::jsonb WHERE id = $1", [ctx.tenantId, JSON.stringify({ ...original, networkEnabled: false })]);
    await page.goto("/admin");
    await expect(page.locator("[data-network-disabled]")).toContainText("hors du réseau");
    await expect(page.getByTestId("network-counter-gps-warning")).toHaveCount(0);
  } finally {
    await pool.query("UPDATE tenants SET config = $2::jsonb WHERE id = $1", [ctx.tenantId, JSON.stringify(original)]);
  }
});
