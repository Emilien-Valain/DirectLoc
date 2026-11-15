import { test, expect } from "@playwright/test";

/**
 * Spécification : Tests de non-régression > Admin > Finitions
 * Issu de la critique design du 2026-10-24 (étape polish) : chaque onglet dit où
 * l'on est, le menu annonce la page courante, la date est en français correct.
 */

test.describe("Admin — Finitions", () => {
  test("chaque page a son titre d'onglet « Page · DirectLoc »", async ({ page }) => {
    for (const [url, title] of [
      ["/admin", "Tableau de bord · DirectLoc"],
      ["/admin/reservations", "Réservations · DirectLoc"],
      ["/admin/reservations/new", "Nouvelle réservation · DirectLoc"],
      ["/admin/calendrier", "Calendrier · DirectLoc"],
      ["/admin/chambres", "Chambres · DirectLoc"],
      ["/admin/regles", "Règles · DirectLoc"],
      ["/admin/parametres", "Paramètres · DirectLoc"],
    ] as const) {
      await page.goto(url);
      await expect(page).toHaveTitle(title);
    }
  });

  test("le menu annonce la page courante (aria-current), une seule à la fois", async ({ page }) => {
    await page.goto("/admin/reservations");
    // Le menu est rendu deux fois (rail bureau + tiroir mobile masqué) : on lit celui qui est affiché.
    const nav = page.locator("[data-admin-sidebar]:visible nav");
    await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
    await expect(nav.getByRole("link", { name: "Réservations" })).toHaveAttribute("aria-current", "page");
  });

  test("date du jour : majuscule au jour seulement, mois en minuscules ; pas d'emoji dans le titre", async ({ page }) => {
    await page.goto("/admin");
    const h1 = page.getByRole("heading", { level: 1 });
    await expect(h1).toHaveText("Bonjour");
    const subtitle = h1.locator("xpath=following-sibling::p[1]");
    await expect(subtitle).toHaveText(/^[A-ZÉ][a-zéû]+ \d{1,2} [a-zéû]+ \d{4}$/);
  });

  test("calendrier : « Synchroniser » est l'action principale, « Aujourd'hui » une navigation", async ({ page }) => {
    await page.goto("/admin/calendrier");
    const sync = page.getByRole("button", { name: "Synchroniser" });
    const today = page.getByRole("link", { name: "Aujourd'hui" });
    const bg = (el: typeof sync) => el.evaluate((n) => getComputedStyle(n).backgroundColor);
    expect(await bg(sync)).not.toBe(await bg(today));
    expect(await bg(today)).toBe("rgb(255, 255, 255)");
  });
});
