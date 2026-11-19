import { test, expect } from "@playwright/test";
import fs from "fs";
import path from "path";
import { fd } from "../helpers/dates";
import { fillGuestContact } from "../helpers/guest";

/**
 * Spécification : Tests de non-régression > Public > « Pour vous joindre » :
 * prénom, nom, email, téléphone et adresse obligatoires, contrôlés par le serveur.
 */

const ctx = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "e2e", ".auth", "test-context.json"), "utf-8"),
) as { apiRoomId: string };

const IN = fd("2026-11-16");
const OUT = fd("2026-11-18");

test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders({
    "x-forwarded-for": `10.45.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`,
  });
  await page.goto(`/reserver/${ctx.apiRoomId}?checkIn=${IN}&checkOut=${OUT}`);
  await expect(page.getByText("Disponible", { exact: true })).toBeVisible({ timeout: 8000 });
});

test.describe("Public — coordonnées obligatoires", () => {
  test("les 5 champs sont présents, étiquetés et obligatoires (plus de « facultatif »)", async ({ page }) => {
    for (const label of ["Prénom", "Nom", "Email", "Téléphone", "Adresse postale"]) {
      await expect(page.getByLabel(label, { exact: true })).toHaveAttribute("required", "");
    }
    await expect(page.getByText("(facultatif)")).toHaveCount(0);
    await expect(page.locator("#guestFirstName")).toHaveAttribute("autocomplete", "given-name");
    await expect(page.locator("#guestAddress")).toHaveAttribute("autocomplete", "street-address");
  });

  test("navigateur : téléphone manquant bloque l'envoi (aucun POST)", async ({ page }) => {
    let posts = 0;
    page.on("request", (r) => { if (r.method() === "POST") posts++; });
    await fillGuestContact(page, { lastName: "Sans Tel", email: "sanstel@example.com", phone: "" });
    await page.getByTestId("booking-submit").click();
    expect(await page.locator("#guestPhone").evaluate((i: HTMLInputElement) => i.validity.valueMissing)).toBe(true);
    expect(posts).toBe(0);
  });

  for (const [name, field, value, message] of [
    ["téléphone vide", "#guestPhone", "", "Téléphone obligatoire"],
    ["téléphone trop court", "#guestPhone", "12 34", "Numéro de téléphone incomplet"],
    ["adresse vide", "#guestAddress", "", "Adresse obligatoire"],
    ["prénom en espaces", "#guestFirstName", "   ", "Prénom obligatoire"],
  ] as const) {
    test(`serveur : ${name} → « ${message} », saisie conservée, champ marqué`, async ({ page }) => {
      await fillGuestContact(page, { firstName: "Marie", lastName: "Garde", email: "garde@example.com" });
      await page.fill(field, value);
      await page.locator("form").evaluate((f: HTMLFormElement) => (f.noValidate = true));
      await page.getByTestId("booking-submit").click();
      await expect(page.getByTestId("booking-error")).toContainText(message);
      await expect(page.locator(field)).toHaveAttribute("aria-invalid", "true");
      await expect(page.locator("#guestLastName")).toHaveValue("Garde");
      await expect(page.locator("#guestEmail")).toHaveValue("garde@example.com");
    });
  }

  test("saisie complète : passe la validation jusqu'au paiement", async ({ page }) => {
    const k = process.env.STRIPE_SECRET_KEY ?? "";
    test.skip(!!k && !k.includes("XXXX") && !k.includes("placeholder"), "vraie clé Stripe : redirection couverte par booking-flow");
    await fillGuestContact(page, { firstName: "Marie", lastName: "Complète", email: `complete-${Date.now()}@example.com` });
    await page.getByTestId("booking-submit").click();
    await expect(page.getByTestId("booking-error")).toContainText("paiement en ligne est momentanément indisponible");
  });
});
