import fs from "fs";
import path from "path";
import { test, expect } from "@playwright/test";
import { fd, fdFr } from "../helpers/dates";

/**
 * Spécification : Tests de non-régression > Public > Parcours des dates
 * (critique/audit des templates, 2026-11-04) : les dates suivent le visiteur,
 * les erreurs de saisie sont dites, le menu mobile se pilote au clavier.
 */

const ctx = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "e2e", ".auth", "test-context.json"), "utf-8"),
) as { apiRoomId: string };

test.use({ extraHTTPHeaders: { "x-forwarded-for": "10.10.0.21" } });

test.describe("Public — parcours des dates", () => {
  test("le bouton « Réserver » de l'en-tête mène à la recherche de dates", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/chambres");
    await page.getByRole("navigation", { name: "Navigation principale" }).getByRole("link", { name: "Réserver" }).click();
    await expect(page).toHaveURL(/\/#dates$/);
    await expect(page.locator("#dates")).toBeInViewport();
  });

  test("page chambre : les dates choisies arrivent pré-remplies sur le formulaire", async ({ page }) => {
    await page.goto("/chambres/chambre-api-test");
    await page.fill("#room-checkin", fd("2026-09-07"));
    await page.fill("#room-checkout", fd("2026-09-09"));
    await page.getByRole("button", { name: "Voir le tarif et réserver" }).click();
    await expect(page).toHaveURL(new RegExp(`/reserver/${ctx.apiRoomId}\\?checkIn=${fd("2026-09-07")}&checkOut=${fd("2026-09-09")}`));
    await expect(page.locator('[name="checkIn"]')).toHaveValue(fd("2026-09-07"));
    await expect(page.getByTestId("booking-summary-nights")).toHaveText(/2\s+nuits/, { timeout: 8000 });
  });

  test("page chambre sans dates : le formulaire s'ouvre vide, sans erreur", async ({ page }) => {
    await page.goto("/chambres/chambre-api-test");
    await page.getByRole("button", { name: "Voir le tarif et réserver" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Réserver Chambre API Test");
    await expect(page.getByTestId("booking-dates-error")).toHaveCount(0);
  });

  test("départ avant l'arrivée : message explicite, paiement bloqué", async ({ page }) => {
    // Dates inversées passées par l'URL : même état qu'une saisie clavier inversée.
    await page.goto(`/reserver/${ctx.apiRoomId}?checkIn=${fd("2026-09-20")}&checkOut=${fd("2026-09-15")}`);
    await expect(page.getByTestId("booking-dates-error")).toHaveText("Le départ doit être après l'arrivée");
    await expect(page.getByTestId("booking-submit")).toBeDisabled();
  });

  test("départ = arrivée : même message", async ({ page }) => {
    await page.goto(`/reserver/${ctx.apiRoomId}?checkIn=${fd("2026-09-20")}&checkOut=${fd("2026-09-20")}`);
    await expect(page.getByTestId("booking-dates-error")).toBeVisible();
  });

  test("nombre de personnes : le champ se vide et se retape, borné à la sortie", async ({ page }) => {
    await page.goto(`/reserver/${ctx.apiRoomId}`);
    const guests = page.locator('[name="guestCount"]');
    await expect(async () => {
      await guests.fill("");
      await expect(guests).toHaveValue("", { timeout: 500 });
    }).toPass({ timeout: 10_000 });
    await guests.pressSequentially("2");
    await expect(guests).toHaveValue("2");
    await expect(page.getByTestId("booking-summary-guests")).toHaveText("2 pers.");
    // Au-delà de la capacité (2) : ramené à 2 en quittant le champ.
    await guests.fill("9");
    await guests.blur();
    await expect(guests).toHaveValue("2");
  });

  test("mobile : barre de total collée en bas une fois le tarif connu", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto(`/reserver/${ctx.apiRoomId}?checkIn=${fd("2026-09-07")}&checkOut=${fd("2026-09-09")}`);
    const bar = page.locator(".s-book-bar");
    await expect(bar).toBeVisible({ timeout: 8000 });
    await expect(bar).toContainText("€");
    await expect(bar.getByRole("button", { name: "Payer" })).toBeEnabled();
  });

  test("desktop : pas de barre de total (le récapitulatif est déjà à côté)", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/reserver/${ctx.apiRoomId}?checkIn=${fd("2026-09-07")}&checkOut=${fd("2026-09-09")}`);
    await expect(page.getByTestId("booking-summary-total")).toContainText("€", { timeout: 8000 });
    await expect(page.locator(".s-book-bar")).toBeHidden();
  });

  test("menu mobile : Échap le referme et rend le focus au bouton", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto("/chambres");
    const btn = page.getByRole("button", { name: "Ouvrir le menu" });
    await btn.click();
    await expect(page.locator("#s-menu-panel")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#s-menu-panel")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Ouvrir le menu" })).toBeFocused();
  });

  test("menu mobile : un clic hors du menu le referme", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto("/chambres");
    await page.getByRole("button", { name: "Ouvrir le menu" }).click();
    await expect(page.locator("#s-menu-panel")).toBeVisible();
    // Clic dans le bas de la page, loin du panneau qui recouvre le haut.
    await page.mouse.click(200, 760);
    await expect(page.locator("#s-menu-panel")).toHaveCount(0);
  });

  test("page chambre : capacité affichée avec le formulaire de dates", async ({ page }) => {
    await page.goto("/chambres/chambre-api-test");
    await expect(page.getByTestId("room-facts")).toContainText("Capacité");
    await expect(page.getByTestId("room-facts")).toContainText("Jusqu'à 2 personnes");
  });

  test("près du bouton de paiement : téléphone de l'hôte cliquable", async ({ page }) => {
    await page.goto(`/reserver/${ctx.apiRoomId}`);
    const reassure = page.getByTestId("booking-reassure");
    await expect(reassure).toContainText("Paiement sécurisé par Stripe");
    await expect(reassure.getByRole("link", { name: "+33 4 90 00 00 00" })).toHaveAttribute("href", "tel:+33 4 90 00 00 00");
  });

  test("recherche avec une arrivée passée : message explicite, pas de résultats", async ({ page }) => {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(new Date());
    const yesterday = new Date(Date.parse(today + "T00:00:00Z") - 86_400_000).toISOString().slice(0, 10);
    await page.goto("/");
    await expect(async () => {
      await page.fill("#search-checkin", yesterday);
      await page.fill("#search-checkout", today);
      await page.getByRole("button", { name: "Voir les disponibilités" }).click();
      await expect(page.getByTestId("search-dates-error")).toHaveText(/déjà passée/, { timeout: 1000 });
    }).toPass({ timeout: 10_000 });
    await expect(page.locator(".s-search-room")).toHaveCount(0);
  });
});

test.describe("Public — dates en JJ/MM/AAAA, quelle que soit la langue du navigateur", () => {
  test.use({ locale: "en-US" });

  test("navigateur anglais : les dates pré-remplies s'affichent en JJ/MM/AAAA", async ({ page }) => {
    await page.goto(`/reserver/${ctx.apiRoomId}?checkIn=${fd("2026-09-07")}&checkOut=${fd("2026-09-09")}`);
    await expect(page.locator("#checkIn")).toHaveValue(fdFr("2026-09-07"));
    await expect(page.locator("#checkOut")).toHaveValue(fdFr("2026-09-09"));
    await expect(page.locator("#checkIn")).toHaveAttribute("placeholder", "jj/mm/aaaa");
  });

  test("saisie au clavier en chiffres : les barres s'ajoutent, le formulaire reçoit la date ISO", async ({ page }) => {
    await page.goto(`/reserver/${ctx.apiRoomId}`);
    const field = page.locator("#checkIn");
    await expect(async () => {
      await field.fill("");
      await field.pressSequentially(fdFr("2026-09-07").replaceAll("/", ""));
      await expect(field).toHaveValue(fdFr("2026-09-07"), { timeout: 500 });
    }).toPass({ timeout: 10_000 });
    await expect(page.locator('[name="checkIn"]')).toHaveValue(fd("2026-09-07"));
    // Le départ est avancé automatiquement au lendemain, affiché lui aussi en JJ/MM/AAAA.
    await expect(page.locator("#checkOut")).toHaveValue(fdFr("2026-09-08"));
  });

  test("date impossible (31/02) : rien n'est envoyé au formulaire", async ({ page }) => {
    await page.goto(`/reserver/${ctx.apiRoomId}`);
    const year = fd("2026-09-07").slice(0, 4);
    await expect(async () => {
      await page.locator("#checkIn").fill(`31/02/${year}`);
      await expect(page.locator("#checkIn")).toHaveValue(`31/02/${year}`, { timeout: 500 });
    }).toPass({ timeout: 10_000 });
    await expect(page.locator('[name="checkIn"]')).toHaveValue("");
  });

  test("le bouton calendrier a un nom accessible", async ({ page }) => {
    await page.goto(`/reserver/${ctx.apiRoomId}`);
    await expect(page.getByRole("button", { name: "Arrivée : ouvrir le calendrier" })).toBeVisible();
  });
});
