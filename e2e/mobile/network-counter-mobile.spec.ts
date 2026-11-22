import fs from "fs";
import path from "path";
import { Pool } from "pg";
import { test, expect } from "@playwright/test";
import { EXPECTED, parseCounts, seedNetworkActivity } from "../helpers/network-activity";

/** Compteur réseau du tableau de bord dans l'admin installé sur téléphone : visible, sans défilement horizontal, sans page.reload(). */
const ctx = JSON.parse(fs.readFileSync(path.join(process.cwd(), "e2e", ".auth", "test-context.json"), "utf-8")) as { tenantId: string; apiRoomId: string };
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
let seeded: Awaited<ReturnType<typeof seedNetworkActivity>> | null = null;

test.afterAll(async () => {
  await seeded?.cleanup();
  await pool.end();
});

test("compteur réseau visible sur téléphone et à jour après navigation (sans rechargement)", async ({ page }) => {
  await page.goto("/login");
  await page.fill('[name="email"]', process.env.TEST_ADMIN_EMAIL ?? "admin@test.maresa");
  await page.fill('[name="password"]', process.env.TEST_ADMIN_PASSWORD ?? "password");
  await page.click('[type="submit"]');
  await expect(page).toHaveURL(/\/admin$/);

  const counter = page.locator("[data-network-counter]");
  await expect(counter).toBeVisible();
  await expect(counter).toContainText("Réseau");
  const before = parseCounts(await page.locator("[data-network-month]").innerText());

  seeded = await seedNetworkActivity(pool, ctx);
  await page.getByRole("button", { name: "Ouvrir le menu" }).click();
  await page.locator("#admin-drawer").getByRole("link", { name: "Chambres" }).click();
  await expect(page).toHaveURL(/\/admin\/chambres$/);
  await page.goto("/admin");
  await expect(counter).toBeVisible();
  const after = parseCounts(await page.locator("[data-network-month]").innerText());
  expect(after.sent - before.sent).toBe(EXPECTED.month.sent);
  expect(after.bookings - before.bookings).toBe(EXPECTED.month.bookings);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
