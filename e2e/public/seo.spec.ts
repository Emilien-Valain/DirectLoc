import { test, expect } from "@playwright/test";
import { eq } from "drizzle-orm";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { tenants, properties, rooms } from "../../db/schema";

/**
 * SEO des sites clients : titre, description, canonical, Open Graph, noindex du tunnel.
 * Spécification : Tests de non-régression > SEO
 */

const XSS = `<script>alert(1)</script>`;
const LONG_DESC = `${XSS} ${"Belle chambre lumineuse avec vue sur le bocage. ".repeat(10)}`;

test.describe("SEO — métadonnées des pages publiques", () => {
  test("accueil : titre au nom de l'hôte, canonical et og:url", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle("Hôtel Test — réservation en direct");
    const canonical = await page.locator('link[rel="canonical"]').getAttribute("href");
    expect(canonical).toMatch(/^https?:\/\/[^/]+\/?$/);
    expect(await page.locator('meta[name="description"]').getAttribute("content")).toBeTruthy();
    expect(await page.locator('meta[property="og:site_name"]').getAttribute("content")).toBe("Hôtel Test");
    expect(await page.locator('meta[name="robots"]').count()).toBe(0);
  });

  test("liste des chambres : titre et canonical /chambres", async ({ page }) => {
    await page.goto("/chambres");
    await expect(page).toHaveTitle("Nos chambres — Hôtel Test");
    expect(await page.locator('link[rel="canonical"]').getAttribute("href")).toMatch(/\/chambres$/);
  });

  test("chambre sans description : titre et description de repli", async ({ page }) => {
    await page.goto("/chambres/chambre-api-test");
    await expect(page).toHaveTitle("Chambre API Test — Hôtel Test");
    expect(await page.locator('meta[name="description"]').getAttribute("content")).toContain("jusqu'à 2 personnes");
    expect(await page.locator('link[rel="canonical"]').getAttribute("href")).toMatch(/\/chambres\/chambre-api-test$/);
  });

  test("chambre inexistante ou d'un autre tenant → 404, pas 500", async ({ request }) => {
    expect((await request.get("/chambres/nexiste-pas")).status()).toBe(404);
    expect((await request.get("/chambres/chambre-rival-test")).status()).toBe(404);
  });

  test("tunnel de réservation en noindex", async ({ page }) => {
    await page.goto("/chambres");
    const href = await page.locator('a[href^="/reserver/"]').first().getAttribute("href");
    await page.goto(href!);
    expect(await page.locator('meta[name="robots"]').getAttribute("content")).toContain("noindex");
  });
});

test.describe("SEO — description longue et injection", () => {
  let roomId: string;
  let pool: Pool;

  test.beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL! });
    const db = drizzle(pool);
    const [tenant] = await db.select().from(tenants).where(eq(tenants.slug, "test-tenant"));
    const [property] = await db.select().from(properties).where(eq(properties.tenantId, tenant.id));
    [{ id: roomId }] = await db
      .insert(rooms)
      .values({
        tenantId: tenant.id,
        propertyId: property.id,
        name: `Seo ${XSS}`,
        slug: "chambre-seo-test",
        pricePerNight: "80.00",
        capacity: 1,
        description: LONG_DESC,
      })
      .returning({ id: rooms.id });
  });

  test.afterAll(async () => {
    await drizzle(pool).delete(rooms).where(eq(rooms.id, roomId));
    await pool.end();
  });

  test("description tronquée à 160 caractères, balises échappées, aucun dialog", async ({ page }) => {
    let dialog = false;
    page.on("dialog", () => { dialog = true; });
    await page.goto("/chambres/chambre-seo-test");
    await expect(page).toHaveTitle(`Seo ${XSS} — Hôtel Test`);
    const desc = (await page.locator('meta[name="description"]').getAttribute("content"))!;
    expect(desc.length).toBeLessThanOrEqual(160);
    expect(desc.endsWith("…")).toBe(true);
    expect(desc).toContain(XSS); // texte brut dans l'attribut, pas une balise
    expect(await page.locator("head script", { hasText: "alert(1)" }).count()).toBe(0);
    expect(dialog).toBe(false);
  });
});
