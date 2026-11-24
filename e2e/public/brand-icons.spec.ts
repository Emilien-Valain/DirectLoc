import { test, expect, type Page } from "@playwright/test";

/**
 * Logo DirectLoc (maison-almanach) : sur la vitrine et la connexion, jamais sur un site d'hôtel.
 * Spécification : Tests de non-régression > Marque > Logo et icônes DirectLoc
 */

const VITRINE = "http://directloc.localhost:3001";

const iconHrefs = (page: Page) =>
  page.locator('head link[rel~="icon"], head link[rel="apple-touch-icon"]').evaluateAll((ls) => ls.map((l) => l.getAttribute("href") ?? ""));

test.describe("Marque — logo et icônes DirectLoc", () => {
  test("vitrine : logo dans l'en-tête et icônes DirectLoc", async ({ page }) => {
    await page.goto(`${VITRINE}/`);
    const mark = page.locator("a.alm-mark svg");
    await expect(mark).toBeVisible();
    // Décoratif à côté du nom écrit : masqué aux lecteurs d'écran, le lien garde « DirectLoc ».
    await expect(mark).toHaveAttribute("aria-hidden", "true");
    await expect(page.locator("a.alm-mark")).toHaveAccessibleName(/DirectLoc/i);
    // Un seul jour réservé (rouge) dans le mois.
    await expect(mark.locator('rect[fill="#c41f27"]')).toHaveCount(1);

    const hrefs = await iconHrefs(page);
    expect(hrefs).toContain("/brand/favicon.ico");
    expect(hrefs).toContain("/brand/directloc-mark.svg");
    expect(hrefs).toContain("/brand/apple-touch-icon.png");
  });

  test("pages légales de la vitrine : logo dans le bandeau", async ({ page }) => {
    await page.goto(`${VITRINE}/mentions-legales`);
    await expect(page.locator("a.alm-mark svg")).toBeVisible();
  });

  test("les fichiers d'icône répondent avec le bon type, sur la vitrine et sur un site d'hôtel", async ({ request }) => {
    // Sur la vitrine, le proxy réécrit tout vers /vitrine : /brand/ doit en être exclu (régression du 2026-11-24).
    for (const [url, type] of [
      [`${VITRINE}/brand/favicon.ico`, "image/"],
      [`${VITRINE}/brand/directloc-mark.svg`, "image/svg+xml"],
      [`${VITRINE}/brand/apple-touch-icon.png`, "image/png"],
      ["/brand/favicon.ico", "image/"],
      ["/brand/directloc-mark.svg", "image/svg+xml"],
      ["/brand/apple-touch-icon.png", "image/png"],
      ["/favicon.ico", "image/"],
    ]) {
      const res = await request.get(url);
      expect(res.status(), url).toBe(200);
      expect(res.headers()["content-type"], url).toContain(type);
    }
  });

  test("marque blanche : un site d'hôtel sans icône n'affiche jamais le logo DirectLoc", async ({ page }) => {
    for (const url of ["/", "/chambres", "/cgv", "/mentions-legales"]) {
      await page.goto(url);
      const hrefs = await iconHrefs(page);
      expect(hrefs.some((h) => h.startsWith("/favicon.ico")), url).toBe(true);
      expect(hrefs.filter((h) => h.includes("/brand/")), url).toEqual([]);
      await expect(page.locator('svg[aria-label="DirectLoc"], a.alm-mark'), url).toHaveCount(0);
    }
  });

  test("connexion sans session : logo et icônes DirectLoc", async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await ctx.newPage();
    for (const url of ["/login", "/forgot-password"]) {
      await page.goto(url);
      expect(await iconHrefs(page), url).toContain("/brand/favicon.ico");
      await expect(page.locator('svg[aria-hidden="true"] rect[fill="#c41f27"]'), url).toHaveCount(1);
    }
    await ctx.close();
  });
});
