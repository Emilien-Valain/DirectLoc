import { test, expect, type Page } from "@playwright/test";

/**
 * Paramètres → Documents légaux dans l'admin installé sur téléphone : 360 px de large,
 * sans rechargement (jamais page.reload()). Lecture seule : rien n'est enregistré.
 */

const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL ?? "admin@test.maresa";
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD ?? "password";

test.use({ viewport: { width: 360, height: 760 } });

async function login(page: Page) {
  await page.goto("/login");
  await page.fill('[name="email"]', ADMIN_EMAIL);
  await page.fill('[name="password"]', ADMIN_PASSWORD);
  await page.click('[type="submit"]');
  await expect(page).toHaveURL(/\/admin$/);
}

test("documents légaux sur téléphone (360 px) : onglet atteignable, rien ne déborde, niveaux et boutons utilisables", async ({ page }) => {
  test.setTimeout(60000);
  await login(page);
  await page.goto("/admin/parametres");
  const tab = page.getByRole("tab", { name: "Documents légaux" });
  await tab.click();
  await expect(page.getByRole("tabpanel", { name: "Documents légaux" })).toBeVisible();
  await expect(page.getByTestId("legal-template-notice")).toBeVisible();

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);

  // Les quatre niveaux tiennent dans la largeur et se choisissent au doigt.
  for (const level of ["flexible", "moderate", "strict", "custom"]) {
    const box = (await page.getByTestId(`cancellation-level-${level}`).boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.x + box.width).toBeLessThanOrEqual(360);
  }
  await page.getByTestId("cancellation-level-strict").click();
  await expect(page.getByTestId("cancellation-preview")).toContainText("jusqu'à 30 jours avant");
  await page.getByTestId("cancellation-level-custom").click();
  await expect(page.locator('textarea[name="cancellationText"]')).toBeVisible();

  const submit = page.getByRole("button", { name: /Enregistrer/ });
  await submit.scrollIntoViewIfNeeded();
  const box = (await submit.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(box.x + box.width).toBeLessThanOrEqual(360);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});
