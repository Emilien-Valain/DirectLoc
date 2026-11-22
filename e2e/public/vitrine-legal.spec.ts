import { test, expect } from "@playwright/test";

/**
 * Pages légales de la vitrine directloc.app : /mentions-legales et /confidentialite.
 * Spécification : Tests de non-régression > Site vitrine > Pages légales
 */

const VITRINE = "http://directloc.localhost:3001";

test.use({ extraHTTPHeaders: { "x-forwarded-for": "10.10.0.43" } });

test.describe("Vitrine — pages légales", () => {
  test("mentions légales : 200, éditeur, SIREN et hébergeur", async ({ page }) => {
    const res = await page.goto(`${VITRINE}/mentions-legales`);
    expect(res?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1, name: "Mentions légales" })).toBeVisible();
    const main = page.locator("main");
    await expect(main).toContainText("Emilien Valain");
    await expect(main).toContainText("898 875 059");
    await expect(main).toContainText("Saint-Laurent-sur-Sèvre");
    await expect(main).toContainText("OVH SAS");
    await expect(main).toContainText("Directeur de la publication");
  });

  test("confidentialité : 200, formulaire de rappel, PostHog, durée, droits et CNIL", async ({ page }) => {
    const res = await page.goto(`${VITRINE}/confidentialite`);
    expect(res?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1, name: "Politique de confidentialité" })).toBeVisible();
    const main = page.locator("main");
    for (const t of ["numéro de téléphone", "PostHog", "3 ans", "CNIL", "emilien.valain@gmail.com"]) {
      await expect(main).toContainText(t);
    }
  });

  test("le pied de page de l'accueil mène aux deux pages", async ({ page }) => {
    await page.goto(`${VITRINE}/`);
    const foot = page.locator("footer.alm-back");
    await foot.getByRole("link", { name: "Mentions légales" }).click();
    await expect(page).toHaveURL(`${VITRINE}/mentions-legales`);
    await page.goto(`${VITRINE}/`);
    await foot.getByRole("link", { name: "Politique de confidentialité" }).click();
    await expect(page).toHaveURL(`${VITRINE}/confidentialite`);
  });

  test("sous chaque formulaire de rappel : « uniquement à vous rappeler » + lien confidentialité", async ({ page }) => {
    await page.goto(`${VITRINE}/`);
    const notes = page.getByText("Votre numéro sert uniquement à vous rappeler.");
    await expect(notes).toHaveCount(2); // coupon du haut et du pied de page
    for (const link of await page.locator(".alm-coupon-note a").all()) {
      await expect(link).toHaveAttribute("href", "/confidentialite");
    }
  });

  for (const path of ["/mentions-legales", "/confidentialite"]) {
    test(`${path} sans défilement horizontal à 360 px`, async ({ page }) => {
      await page.setViewportSize({ width: 360, height: 740 });
      await page.goto(`${VITRINE}${path}`);
      await expect(page.locator("main h1")).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    });
  }

  test("l'accueil vitrine sans défilement horizontal à 360 px avec le pied de page légal", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto(`${VITRINE}/`);
    await expect(page.getByRole("link", { name: "Mentions légales" })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test("sur un domaine d'hôtel, ces chemins ne servent pas les pages vitrine", async ({ page, request }) => {
    for (const path of ["/mentions-legales", "/confidentialite"]) {
      const res = await request.get(path);
      expect(res.status()).toBeLessThan(500);
      const body = await res.text();
      expect(body).not.toContain("898 875 059 ");
      expect(body).not.toContain("Direct<span>Loc</span>");
      expect(body).not.toContain("alm-legal");
    }
    // Les chemins internes /vitrine/* restent 404 hors vitrine.
    expect((await request.get("/vitrine/mentions-legales")).status()).toBe(404);
    expect((await request.get("/vitrine/confidentialite")).status()).toBe(404);
    await page.goto("/mentions-legales");
    await expect(page.locator(".alm-legal")).toHaveCount(0);
  });
});
