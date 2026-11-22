import fs from "fs";
import path from "path";
import { Pool } from "pg";
import { test, expect } from "@playwright/test";
import { startFakeStripe, type FakeStripe } from "../helpers/fake-stripe";

/**
 * Spécification : Tests de non-régression > Admin > Paramètres > Stripe Connect.
 * Onboarding d'un hôtel en Accounts v2 (Stripe refuse désormais POST /v1/accounts) : compte
 * SaaS (merchant + card_payments, dashboard full, frais et pertes chez Stripe), lien
 * d'onboarding v2, statut lu sur `configuration.merchant.capabilities.card_payments.status`.
 * Le faux Stripe (e2e/helpers/fake-stripe.ts) reçoit les appels du serveur Next.
 */

const ctx = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "e2e", ".auth", "test-context.json"), "utf-8"),
) as { tenantId: string };

let pool: Pool;
let stripe: FakeStripe;
let saved: string | null;

const accountId = async () =>
  (await pool.query("SELECT stripe_account_id FROM tenants WHERE id = $1", [ctx.tenantId])).rows[0]
    .stripe_account_id as string | null;

test.beforeAll(async () => {
  pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  stripe = await startFakeStripe();
  saved = await accountId();
});
test.afterAll(async () => {
  // test-tenant garde son compte factice (global-setup) pour les specs de paiement.
  await pool.query("UPDATE tenants SET stripe_account_id = $2 WHERE id = $1", [ctx.tenantId, saved]);
  await stripe.close();
  await pool.end();
});
test.beforeEach(async () => {
  await pool.query("UPDATE tenants SET stripe_account_id = NULL WHERE id = $1", [ctx.tenantId]);
  stripe.accountCreates.length = 0;
  stripe.accountLinks.length = 0;
  stripe.accountRetrieves.length = 0;
  stripe.rejectAccountCreate = false;
});

test.describe("Admin — Stripe Connect (Accounts v2)", () => {
  test("Connecter Stripe : compte v2 créé, id stocké, redirection vers l'onboarding ; incomplet puis actif", async ({ page }) => {
    await page.goto("/admin/parametres?tab=calendriers");
    await page.getByRole("button", { name: /connecter stripe/i }).click();
    await expect(page).toHaveURL(/localhost:3995\/onboarding\/acct_fake_/, { timeout: 15_000 });

    // Création du compte : JSON v2, pas de champ v1, modèle SaaS (hôtel marchand).
    expect(stripe.accountCreates).toHaveLength(1);
    const create = stripe.accountCreates[0];
    expect(create.headers["content-type"]).toContain("application/json");
    expect(create.headers["stripe-version"]).toBeTruthy();
    expect(create.body).not.toHaveProperty("type");
    expect(create.body).not.toHaveProperty("controller");
    // Plateforme FR : ni nom ni email (account token obligatoire), l'onboarding Stripe les collecte.
    expect(create.body).not.toHaveProperty("display_name");
    expect(create.body).not.toHaveProperty("contact_email");
    expect(create.body).toMatchObject({
      identity: { country: "FR" },
      dashboard: "full",
      defaults: { responsibilities: { fees_collector: "stripe", losses_collector: "stripe" } },
      configuration: { merchant: { capabilities: { card_payments: { requested: true } } } },
    });
    expect(create.body.configuration).not.toHaveProperty("recipient");

    const id = await accountId();
    expect(id).toMatch(/^acct_fake_/);

    // Lien d'onboarding v2 sur le domaine du tenant.
    expect(stripe.accountLinks).toHaveLength(1);
    expect(stripe.accountLinks[0].body).toEqual({
      account: id,
      use_case: {
        type: "account_onboarding",
        account_onboarding: {
          configurations: ["merchant"],
          refresh_url: "http://localhost:3001/admin/parametres?stripe=refresh",
          return_url: "http://localhost:3001/admin/parametres?stripe=success",
        },
      },
    });

    // Retour de Stripe, card_payments pas encore actif → onboarding à reprendre.
    stripe.capabilityStatus[id!] = "pending";
    await page.goto("/admin/parametres?stripe=success");
    await expect(page.getByText("Configuration Stripe mise à jour avec succès.")).toBeVisible();
    await expect(page.getByText("La configuration de votre compte Stripe n'est pas terminée.")).toBeVisible();
    expect(stripe.accountRetrieves.at(-1)).toContain(`/v2/core/accounts/${id}`);
    expect(decodeURIComponent(stripe.accountRetrieves.at(-1)!)).toContain("configuration.merchant");

    // Reprendre : pas de second compte, nouveau lien pour le même compte.
    await page.getByRole("button", { name: "Reprendre la configuration" }).click();
    await expect(page).toHaveURL(new RegExp(`localhost:3995/onboarding/${id}`), { timeout: 15_000 });
    expect(stripe.accountCreates).toHaveLength(1);
    expect(stripe.accountLinks).toHaveLength(2);
    expect((stripe.accountLinks[1].body as { account: string }).account).toBe(id);

    // card_payments actif → connecté.
    stripe.capabilityStatus[id!] = "active";
    await page.goto("/admin/parametres?tab=calendriers");
    await expect(page.getByText("Connecté", { exact: true })).toBeVisible();
    await expect(page.getByText(id!)).toBeVisible();
    await expect(page.getByRole("link", { name: /Ouvrir le Dashboard Stripe/ })).toBeVisible();
  });

  test("capacité « restricted » : jamais affiché comme connecté", async ({ page }) => {
    await pool.query("UPDATE tenants SET stripe_account_id = 'acct_fake_restricted' WHERE id = $1", [ctx.tenantId]);
    stripe.capabilityStatus["acct_fake_restricted"] = "restricted";
    await page.goto("/admin/parametres?tab=calendriers");
    await expect(page.getByRole("button", { name: "Reprendre la configuration" })).toBeVisible();
    await expect(page.getByText("Connecté", { exact: true })).toHaveCount(0);
  });

  test("Stripe refuse la création : message d'erreur, aucun compte stocké, pas de 500", async ({ page }) => {
    stripe.rejectAccountCreate = true;
    await page.goto("/admin/parametres?tab=calendriers");
    const res = page.waitForResponse((r) => r.url().endsWith("/api/admin/stripe/connect"));
    await page.getByRole("button", { name: /connecter stripe/i }).click();
    expect((await res).status()).toBe(502);
    await expect(page.getByText("Stripe n'a pas pu ouvrir la configuration de votre compte.")).toBeVisible();
    await expect(page).toHaveURL(/\/admin\/parametres/);
    expect(await accountId()).toBeNull();
    expect(stripe.accountLinks).toHaveLength(0);
  });
});
