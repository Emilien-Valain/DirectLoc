import fs from "fs";
import path from "path";
import { Pool } from "pg";
import { test, expect } from "@playwright/test";
import { resetTenantContentSeed } from "../helpers/seed-tenant-config";

/**
 * Réseau des Voisins (issue 01) — Paramètres → Localisation : encart GPS et commune.
 * Référence : Tests de non-régression.md > Admin > Réseau des Voisins.
 */
const ctx = JSON.parse(fs.readFileSync(path.join(process.cwd(), "e2e", ".auth", "test-context.json"), "utf-8")) as {
  tenantId: string;
};
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });

async function setConfig(patch: string, removeKeys: string[] = []) {
  await pool.query(
    `UPDATE tenants SET config = (config - $2::text[]) || $3::jsonb WHERE id = $1`,
    [ctx.tenantId, removeKeys, patch],
  );
}

test.describe("Admin — Réseau des Voisins (localisation)", () => {
  test.describe.configure({ mode: "serial" });
  test.afterAll(async () => {
    // Remet GPS (seed) et retire la commune posée par les tests.
    await resetTenantContentSeed();
    await setConfig("{}", ["city", "networkEnabled"]);
    await pool.end();
  });

  test("avec coordonnées : pas d'encart d'avertissement", async ({ page }) => {
    await resetTenantContentSeed();
    await page.goto("/admin/parametres");
    await expect(page.locator("#loc-latitude")).not.toHaveValue("");
    await expect(page.getByTestId("network-gps-warning")).toHaveCount(0);
  });

  test("sans coordonnées : encart visible, disparaît dès qu'on saisit les coordonnées", async ({ page }) => {
    await setConfig("{}", ["latitude", "longitude"]);
    await page.goto("/admin/parametres");
    const warn = page.getByTestId("network-gps-warning");
    await expect(warn).toBeVisible();
    await expect(warn).toContainText("Sans position GPS, votre établissement n'apparaît pas dans le réseau des voisins");
    await page.locator("#loc-latitude").fill("46.8906");
    await page.locator("#loc-longitude").fill("-0.9295");
    await expect(warn).toHaveCount(0);
    // Effacer de nouveau : l'encart revient (texte partiel, coordonnée incomplète).
    await page.locator("#loc-longitude").fill("");
    await expect(warn).toBeVisible();
    await page.locator("#loc-longitude").fill("abc");
    await expect(warn).toBeVisible();
  });

  test("commune : enregistrée, rechargée ; XSS échappé ; trop longue refusée ; vide = retirée", async ({ page }) => {
    await resetTenantContentSeed();
    await page.goto("/admin/parametres");
    const city = page.locator("#loc-city");
    let dialog = false;
    page.on("dialog", (d) => {
      dialog = true;
      void d.dismiss();
    });

    await city.fill("<script>alert(1)</script>Épesses");
    await page.getByRole("button", { name: "Enregistrer l'adresse et la carte" }).click();
    await expect(page.getByText("Localisation mise à jour avec succès.")).toBeVisible();
    await page.reload();
    await expect(page.locator("#loc-city")).toHaveValue("<script>alert(1)</script>Épesses");
    expect(dialog).toBe(false);

    // Plus de 100 caractères : refusé côté serveur (le maxLength du champ est contourné).
    await page.locator("#loc-city").evaluate((el) => {
      (el as HTMLInputElement).removeAttribute("maxlength");
      (el as HTMLInputElement).form!.noValidate = true;
    });
    await page.locator("#loc-city").fill("x".repeat(101));
    await page.getByRole("button", { name: "Enregistrer l'adresse et la carte" }).click();
    await expect(page.getByText("Commune trop longue").first()).toBeVisible();

    await page.locator("#loc-city").fill("Les Épesses");
    await page.getByRole("button", { name: "Enregistrer l'adresse et la carte" }).click();
    await expect(page.getByText("Localisation mise à jour avec succès.")).toBeVisible();
    const saved = await pool.query("SELECT config->>'city' AS city, config->'networkEnabled' AS ne FROM tenants WHERE id = $1", [ctx.tenantId]);
    expect(saved.rows[0].city).toBe("Les Épesses");
    expect(saved.rows[0].ne).toBeNull(); // l'hôte ne touche jamais à networkEnabled

    await page.locator("#loc-city").fill("");
    await page.getByRole("button", { name: "Enregistrer l'adresse et la carte" }).click();
    await expect(page.getByText("Localisation mise à jour avec succès.")).toBeVisible();
    const cleared = await pool.query("SELECT config ? 'city' AS has FROM tenants WHERE id = $1", [ctx.tenantId]);
    expect(cleared.rows[0].has).toBe(false);
  });

  test("l'hôte ne voit aucun interrupteur du réseau (réservé à l'opérateur)", async ({ page }) => {
    await page.goto("/admin/parametres");
    await expect(page.locator("[name='networkEnabled']")).toHaveCount(0);
    await expect(page.getByText(/networkEnabled/)).toHaveCount(0);
  });
});
