import { test, expect, type Page } from "@playwright/test";

/**
 * Admin utilisé comme application installée sur Android (Chrome « Installer l'application »).
 * Particularités reproduites : écran de téléphone (menu en tiroir), geste Retour,
 * et surtout AUCUN rechargement de page — l'app n'a ni barre d'adresse ni bouton recharger.
 * Ne jamais appeler page.reload() ici : le bug appart-alma (2026-11-18) ne se voyait qu'ainsi.
 */

const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL ?? "admin@test.maresa";
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD ?? "password";

async function login(page: Page) {
  await page.fill('[name="email"]', ADMIN_EMAIL);
  await page.fill('[name="password"]', ADMIN_PASSWORD);
  await page.click('[type="submit"]');
}

async function menu(page: Page) {
  await page.getByRole("button", { name: "Ouvrir le menu" }).click();
  return page.locator("#admin-drawer");
}

test.describe("Admin en application mobile (PWA Android)", () => {
  test("déconnexion → Retour → reconnexion : chaque onglet du menu s'ouvre, sans boucle sur /login", async ({ page }) => {
    test.setTimeout(90000);
    await page.goto("/login");
    await login(page);
    await expect(page).toHaveURL(/\/admin$/);

    // Visite des pages comme l'admin le matin même (préchargements en cache côté client).
    for (const [name, path] of [["Chambres", "/admin/chambres"], ["Règles", "/admin/regles"]] as const) {
      await (await menu(page)).getByRole("link", { name }).click();
      await expect(page).toHaveURL(new RegExp(`${path}$`));
    }

    await (await menu(page)).getByRole("button", { name: "Déconnexion" }).click();
    await expect(page).toHaveURL(/\/login$/);

    // Geste Retour d'Android : l'admin ne doit jamais réapparaître sans session.
    await page.goBack();
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole("button", { name: "Ouvrir le menu" })).toHaveCount(0);

    // Reconnexion SANS rechargement, puis navigation dans tous les onglets.
    if (!/\/login/.test(page.url())) await page.goto("/login");
    await login(page);
    await expect(page).toHaveURL(/\/admin/);
    for (const [name, path] of [
      ["Chambres", "/admin/chambres"],
      ["Calendrier", "/admin/calendrier"],
      ["Règles", "/admin/regles"],
      ["Réservations", "/admin/reservations"],
      ["Chambres", "/admin/chambres"],
    ] as const) {
      await (await menu(page)).getByRole("link", { name }).click();
      await expect(page).toHaveURL(new RegExp(`${path}$`));
    }
  });

  test("session perdue pendant l'utilisation (déconnecté ailleurs) → /login?redirect, puis retour sur la page demandée", async ({ page, context }) => {
    test.setTimeout(60000);
    await page.goto("/login");
    await login(page);
    await expect(page).toHaveURL(/\/admin$/);
    // Précharge les liens du menu pendant que la session est valide.
    await menu(page);

    // Session révoquée côté serveur (déconnexion depuis un autre appareil, expiration…).
    await context.clearCookies();
    await page.keyboard.press("Escape");
    await (await menu(page)).getByRole("link", { name: "Chambres" }).click();
    await expect(page).toHaveURL(/\/login/);

    await login(page);
    await expect(page).toHaveURL(/\/admin\/chambres$/);
    await (await menu(page)).getByRole("link", { name: "Calendrier" }).click();
    await expect(page).toHaveURL(/\/admin\/calendrier/);
  });
});
