import { test, expect } from "@playwright/test";
import { startSmtpSink } from "../helpers/smtp-sink";

/**
 * Site vitrine directloc.app (monde « Almanach »).
 * Servi sur MARKETING_HOST (tests : directloc.localhost:3001) par réécriture vers app/vitrine.
 * Spécification : Tests de non-régression > Site vitrine
 */

const VITRINE = "http://directloc.localhost:3001";

// IP dédiée : le formulaire de rappel est limité à 5 envois / heure / IP.
test.use({ extraHTTPHeaders: { "x-forwarded-for": "10.10.0.42" } });

test.describe("Site vitrine — routage", () => {
  test("la page d'accueil répond sur le domaine vitrine", async ({ page }) => {
    const res = await page.goto(`${VITRINE}/`);
    expect(res?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Zéro commission");
    await expect(page.getByRole("button", { name: "Être rappelé" }).first()).toBeVisible();
    await expect(page.getByText("calendrier de démonstration")).toBeVisible();
  });

  test("/vitrine n'est jamais accessible depuis un domaine client", async ({ request }) => {
    expect((await request.get("/vitrine")).status()).toBe(404);
    expect((await request.get("/vitrine/x")).status()).toBe(404);
  });

  test("le domaine client sert toujours le site de l'hôte, pas la vitrine", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("calendrier de démonstration")).toHaveCount(0);
  });

  test("/admin et /api sur le domaine vitrine → 404, jamais 500", async ({ request }) => {
    expect((await request.get(`${VITRINE}/admin`, { maxRedirects: 0 })).status()).toBe(404);
    expect((await request.get(`${VITRINE}/api/rooms/available`)).status()).toBe(404);
  });

  test("une page inexistante du domaine vitrine → 404", async ({ request }) => {
    expect((await request.get(`${VITRINE}/page-qui-nexiste-pas`)).status()).toBe(404);
  });
});

test.describe("Site vitrine — barème", () => {
  test("le calcul suit le chiffre d'affaires saisi, y compris 0 et les lettres", async ({ page }) => {
    await page.goto(`${VITRINE}/`);
    const ca = page.getByLabel(/chiffre d'affaires annuel/);
    await expect(page.getByText("3 400 €").first()).toBeVisible(); // 20 000 € × 17 %

    await ca.fill("100000");
    await expect(page.getByRole("row", { name: /Commissions versées/ })).toContainText("17 000 €");

    await ca.fill("0");
    await expect(page.getByText("Saisissez un montant")).toBeVisible();

    await ca.fill("abc");
    await expect(ca).toHaveValue(""); // seuls les chiffres passent
  });
});

test.describe("Site vitrine — formulaire de rappel", () => {
  const form = (page: import("@playwright/test").Page) => page.locator("form.alm-coupon").first();

  test("champs vides → erreurs par champ, aucun e-mail", async ({ page }) => {
    await page.goto(`${VITRINE}/`);
    await form(page).getByRole("button", { name: "Être rappelé" }).click();
    await expect(form(page).getByText("Indiquez votre nom")).toBeVisible();
    await expect(form(page).getByText(/Numéro de téléphone invalide/)).toBeVisible();
  });

  test("téléphone invalide et nom trop long sont refusés", async ({ page }) => {
    await page.goto(`${VITRINE}/`);
    await form(page).getByLabel("Nom").fill("x".repeat(100) + "y"); // maxLength coupe à 100 côté navigateur
    await expect(form(page).getByLabel("Nom")).toHaveValue("x".repeat(100));
    await form(page).getByLabel("Téléphone").fill("12ab");
    await form(page).getByRole("button", { name: "Être rappelé" }).click();
    await expect(form(page).getByText(/Numéro de téléphone invalide/)).toBeVisible();
  });

  test("demande valide → confirmation et e-mail à l'opérateur, contenu échappé", async ({ page }) => {
    const sink = await startSmtpSink();
    let dialog = false;
    page.on("dialog", (d) => { dialog = true; void d.dismiss(); });
    try {
      await page.goto(`${VITRINE}/`);
      await form(page).getByLabel("Nom").fill("<script>alert(1)</script>Martine");
      await form(page).getByLabel("Téléphone").fill("06 12 34 56 78");
      await form(page).getByLabel(/Votre hébergement/).fill("Gîte, Les Epesses");
      await form(page).getByRole("button", { name: "Être rappelé" }).click();
      await expect(form(page).getByRole("status")).toContainText("C'est noté");
      await expect.poll(() => sink.mails.length).toBe(1);
      const mail = sink.mails[0];
      expect(mail.to.join()).toContain("operateur@directloc.test");
      expect(mail.raw).not.toContain("<script>");
      expect(dialog).toBe(false);
    } finally {
      await sink.stop();
    }
  });

  test("champ piège rempli (robot) → pas d'e-mail, pas d'erreur visible", async ({ page }) => {
    const sink = await startSmtpSink();
    try {
      await page.goto(`${VITRINE}/`);
      await form(page).getByLabel("Nom").fill("Robot");
      await form(page).getByLabel("Téléphone").fill("06 12 34 56 78");
      await form(page).locator('input[name="website"]').fill("http://spam.example", { force: true });
      await form(page).getByRole("button", { name: "Être rappelé" }).click();
      await expect(form(page).getByRole("status")).toBeVisible();
      await page.waitForTimeout(500);
      expect(sink.mails.length).toBe(0);
    } finally {
      await sink.stop();
    }
  });
});
