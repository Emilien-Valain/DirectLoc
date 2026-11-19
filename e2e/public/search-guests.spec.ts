import { test, expect, type Page } from "@playwright/test";
import fs from "fs";
import path from "path";
import { Pool } from "pg";
import { fd } from "../helpers/dates";

/**
 * Spécification : Tests de non-régression > Public > Recherche avec nombre de voyageurs.
 * Chambre API Test : 2 pers. Une chambre familiale (4 pers.) est créée le temps du fichier.
 */

const ctx = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "e2e", ".auth", "test-context.json"), "utf-8"),
) as { tenantId: string; apiRoomId: string };

const FAMILY = "Chambre Familiale Recherche";
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
let familyId: string;

const FROM = fd("2026-10-12");
const TO = fd("2026-10-14");

test.use({ extraHTTPHeaders: { "x-forwarded-for": "10.10.0.23" } });

test.beforeAll(async () => {
  await pool.query("DELETE FROM rooms WHERE tenant_id = $1 AND name = $2", [ctx.tenantId, FAMILY]);
  const { rows } = await pool.query(
    `INSERT INTO rooms (tenant_id, property_id, name, slug, price_per_night, capacity, email_message)
     SELECT tenant_id, property_id, $2, 'chambre-familiale-recherche', '150.00', 4, 'Code secret 9876'
     FROM rooms WHERE id = $1 RETURNING id`,
    [ctx.apiRoomId, FAMILY],
  );
  familyId = rows[0].id;
});
test.afterAll(async () => {
  await pool.query("DELETE FROM rooms WHERE id = $1", [familyId]);
  await pool.end();
});

const available = (page: Page, guests?: string) =>
  page.request.get("/api/rooms/available", {
    params: { from: FROM, to: TO, ...(guests !== undefined ? { guests } : {}) },
  });

test.describe("Public — recherche par nombre de voyageurs", () => {
  test("API : guests filtre par capacité ; absent = toutes les chambres", async ({ page }) => {
    const ids = async (guests?: string) =>
      ((await (await available(page, guests)).json()).rooms as { id: string }[]).map((r) => r.id);
    const all = await ids();
    expect(all).toEqual(expect.arrayContaining([ctx.apiRoomId, familyId]));
    const three = await ids("3");
    expect(three).toContain(familyId);
    expect(three).not.toContain(ctx.apiRoomId);
    expect(await ids("2")).toEqual(expect.arrayContaining([ctx.apiRoomId, familyId]));
    // Limite : capacité exacte acceptée, au-delà personne.
    expect(await ids("4")).toContain(familyId);
    expect(await ids("5")).not.toContain(familyId);
  });

  test("API : guests invalide (0, 51, abc, 2.5, vide) → 400, jamais 500", async ({ page }) => {
    for (const g of ["0", "51", "abc", "2.5", "-1"]) {
      const res = await available(page, g);
      expect(res.status(), `guests=${g}`).toBe(400);
      expect((await res.json()).error).toContain("Nombre de voyageurs invalide");
    }
  });

  test("API : seuls les champs publics sortent (pas le message d'email de la chambre)", async ({ page }) => {
    const body = await (await available(page)).text();
    expect(body).not.toContain("Code secret 9876");
    expect(body).not.toContain("emailMessage");
  });

  test("accueil : champ Voyageurs jusqu'à la plus grande capacité ; 3 pers. → seule la familiale, lien pré-rempli", async ({ page }) => {
    await page.goto("/");
    const guests = page.getByLabel("Voyageurs");
    await expect(guests).toHaveValue("1");
    await expect(guests.locator("option").last()).toHaveText(/\d+ pers\./);
    expect(Number(await guests.locator("option").last().getAttribute("value"))).toBeGreaterThanOrEqual(4);

    await expect(async () => {
      await page.fill("#search-checkin", FROM);
      await page.fill("#search-checkout", TO);
      await guests.selectOption("3");
      await page.getByRole("button", { name: "Voir les disponibilités" }).click();
      await expect(page.locator(".s-search-room").first()).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: 15_000 });
    await expect(page.locator(".s-search-result")).toContainText("3 personnes");
    await expect(page.locator(".s-search-room", { hasText: FAMILY })).toBeVisible();
    await expect(page.locator(".s-search-room", { hasText: "Chambre API Test" })).toHaveCount(0);

    await page.locator(".s-search-room", { hasText: FAMILY }).click();
    await expect(page).toHaveURL(new RegExp(`/reserver/${familyId}\\?checkIn=${FROM}&checkOut=${TO}&guests=3`));
    await expect(page.locator("#guestCount")).toHaveValue("3");
  });

  test("réservation : ?guests= borné à la capacité ; invalide → 1", async ({ page }) => {
    await page.goto(`/reserver/${ctx.apiRoomId}?guests=99`);
    await expect(page.locator("#guestCount")).toHaveValue("2");
    await page.goto(`/reserver/${ctx.apiRoomId}?guests=abc`);
    await expect(page.locator("#guestCount")).toHaveValue("1");
    await page.goto(`/reserver/${ctx.apiRoomId}?guests=-4`);
    await expect(page.locator("#guestCount")).toHaveValue("1");
  });

  test("téléphone : le formulaire de recherche tient dans l'écran (pas de défilement horizontal)", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto("/");
    await expect(page.getByLabel("Voyageurs")).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
