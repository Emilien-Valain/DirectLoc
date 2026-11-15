import { test, expect } from "@playwright/test";
import { startSmtpSink } from "../helpers/smtp-sink";

/**
 * Spécification : Tests de non-régression > Auth > Mot de passe oublié
 * Référence Obsidian : Phase 9.2 — Mot de passe oublié
 *
 * Stratégie : happy path + cas limites + sécurité.
 * Le lien de l'email est capturé par un faux SMTP (helper `startSmtpSink`).
 */

// ─── Happy path ────────────────────────────────────────────────────────────────

test.describe("Auth — Mot de passe oublié", () => {
  test("la page /forgot-password est accessible", async ({ page }) => {
    await page.goto("/forgot-password");
    await expect(page.locator("h1")).toContainText("Mot de passe");
    await expect(page.locator('[name="email"]')).toBeVisible();
  });

  test("le lien 'Mot de passe oublié' est présent sur /login", async ({ page }) => {
    await page.goto("/login");
    const link = page.locator('a[href="/forgot-password"]');
    await expect(link).toBeVisible();
    await link.click();
    await expect(page).toHaveURL(/\/forgot-password/);
  });

  test("soumettre un email affiche le message de succès", async ({ page }) => {
    await page.goto("/forgot-password");
    await page.fill('[name="email"]', "test@example.com");
    await page.click('[type="submit"]');
    // Message de succès toujours affiché (anti-énumération)
    await expect(page.getByText("recevrez un email")).toBeVisible({ timeout: 10000 });
  });

  test("soumettre un email inexistant affiche le même message de succès (anti-énumération)", async ({ page }) => {
    await page.goto("/forgot-password");
    await page.fill('[name="email"]', "inexistant-xyz-12345@example.com");
    await page.click('[type="submit"]');
    await expect(page.getByText("recevrez un email")).toBeVisible({ timeout: 10000 });
  });

  test("le lien de l'email pointe sur le domaine du tenant, pas sur BETTER_AUTH_URL", async ({ page }) => {
    // Sous-domaine du tenant de test : BETTER_AUTH_URL vaut http://localhost:3001,
    // le lien doit pourtant ramener sur l'origine depuis laquelle l'admin a demandé le reset.
    const tenantOrigin = "http://test-tenant.localhost:3001";
    const sink = await startSmtpSink();
    try {
      await page.goto(`${tenantOrigin}/forgot-password`);
      await page.fill('[name="email"]', process.env.TEST_ADMIN_EMAIL!);
      await page.click('[type="submit"]');
      await expect(page.getByText("recevrez un email")).toBeVisible({ timeout: 10000 });
      await expect.poll(() => sink.mails.length, { timeout: 10000 }).toBe(1);

      // Décodage quoted-printable minimal (soft breaks + =XX) puis entités HTML de l'attribut href
      const body = sink.mails[0].raw
        .replace(/=\r\n/g, "")
        .replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
        .replace(/&amp;/g, "&");
      const href = /href="([^"]*\/reset-password\/[^"]*)"/.exec(body)?.[1];
      expect(href, "lien de reset absent de l'email").toBeTruthy();
      expect(href!.startsWith(`${tenantOrigin}/api/auth/reset-password/`)).toBe(true);
      const callback = new URL(href!).searchParams.get("callbackURL");
      expect(callback).toBe(`${tenantOrigin}/reset-password`);

      // Le lien mène au formulaire de reset du tenant, avec le token
      await page.goto(href!);
      await expect(page).toHaveURL(new RegExp(`^${tenantOrigin}/reset-password\\?token=`));
    } finally {
      await sink.stop();
    }
  });

  // ─── Reset password page ──────────────────────────────────────────────────

  test("la page /reset-password sans token affiche 'Lien invalide'", async ({ page }) => {
    await page.goto("/reset-password");
    await expect(page.getByRole("heading", { name: "Lien invalide" })).toBeVisible();
  });

  test("la page /reset-password avec un token invalide affiche une erreur au submit", async ({ page }) => {
    await page.goto("/reset-password?token=faux-token-12345");
    await page.fill('[name="password"]', "nouveaumotdepasse123");
    await page.fill('[name="confirm"]', "nouveaumotdepasse123");
    await page.click('[type="submit"]');
    await expect(page.locator('p[role="alert"]')).toBeVisible({ timeout: 10000 });
  });

  // ─── Cas limites ────────────────────────────────────────────────────────────

  test("reset password : mots de passe différents → erreur client", async ({ page }) => {
    await page.goto("/reset-password?token=dummy");
    await page.fill('[name="password"]', "motdepasse123");
    await page.fill('[name="confirm"]', "autrechose456");
    await page.click('[type="submit"]');
    await expect(page.locator('p[role="alert"]')).toContainText("correspondent pas");
  });

  test("reset password : mot de passe trop court → formulaire bloqué par validation HTML", async ({ page }) => {
    await page.goto("/reset-password?token=dummy");
    await page.fill('[name="password"]', "court");
    await page.fill('[name="confirm"]', "court");
    await page.click('[type="submit"]');
    // La validation HTML minLength=8 empêche le submit, on reste sur la même page
    await expect(page).toHaveURL(/\/reset-password/);
    // Pas d'erreur JS affichée (le navigateur gère la validation)
  });

  test("forgot-password : email vide → formulaire bloqué par validation HTML", async ({ page }) => {
    await page.goto("/forgot-password");
    const submitBtn = page.locator('[type="submit"]');
    await submitBtn.click();
    // Le formulaire ne soumet pas (validation HTML required)
    await expect(page).toHaveURL(/\/forgot-password/);
  });

  // ─── Sécurité ──────────────────────────────────────────────────────────────

  test("XSS dans le champ email de forgot-password → pas d'exécution de script", async ({ page }) => {
    await page.goto("/forgot-password");
    await page.fill('[name="email"]', '<script>alert(1)</script>@test.com');
    await page.click('[type="submit"]');
    // Pas de dialog JavaScript
    page.on("dialog", () => {
      throw new Error("Dialog XSS détecté !");
    });
    // Attendre un peu pour vérifier qu'aucun dialog n'apparaît
    await page.waitForTimeout(1000);
  });

  test("message de succès login après reset", async ({ page }) => {
    await page.goto("/login?reset=success");
    await expect(page.getByText("réinitialisé")).toBeVisible({ timeout: 10000 });
  });
});
