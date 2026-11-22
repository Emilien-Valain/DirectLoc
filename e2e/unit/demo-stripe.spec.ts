import { test, expect } from "@playwright/test";
import type Stripe from "stripe";
import { connectedAccountParams, connectedAccountStatus, getStripe, onboardingLinkParams, stripeModeAllowed } from "../../lib/stripe";

/**
 * `.scratch/demo-mode/issues/04` : le tenant démo reste en Stripe test même quand la
 * plateforme passe en clé live. Le refus du client test fait échouer la création de
 * session dans `createBookingPublic`, dont le catch supprime le booking pending.
 */
test.describe("Stripe test du tenant démo", () => {
  const saved = { main: process.env.STRIPE_SECRET_KEY, test: process.env.STRIPE_TEST_SECRET_KEY };
  test.afterEach(() => {
    process.env.STRIPE_SECRET_KEY = saved.main;
    if (saved.test === undefined) delete process.env.STRIPE_TEST_SECRET_KEY;
    else process.env.STRIPE_TEST_SECRET_KEY = saved.test;
  });

  test("clé principale live + pas de clé test → client test refusé", () => {
    process.env.STRIPE_SECRET_KEY = "sk_live_xxx";
    delete process.env.STRIPE_TEST_SECRET_KEY;
    expect(() => getStripe({ test: true })).toThrow(/STRIPE_TEST_SECRET_KEY/);
  });

  test("clé principale test → réutilisée pour la démo", () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_xxx";
    delete process.env.STRIPE_TEST_SECRET_KEY;
    expect(() => getStripe({ test: true })).not.toThrow();
  });

  test("plateforme live : événement test → seul le démo est touché", () => {
    process.env.STRIPE_SECRET_KEY = "sk_live_xxx";
    expect(stripeModeAllowed(false, false)).toBe(false); // booking non démo inchangé
    expect(stripeModeAllowed(false, true)).toBe(true); // booking démo confirmé
    expect(stripeModeAllowed(true, false)).toBe(true);
  });

  test("événement live → jamais le démo", () => {
    process.env.STRIPE_SECRET_KEY = "sk_live_xxx";
    expect(stripeModeAllowed(true, true)).toBe(false);
    process.env.STRIPE_SECRET_KEY = "sk_test_xxx";
    expect(stripeModeAllowed(true, true)).toBe(false);
  });

  test("plateforme encore en clé test : événements test acceptés pour tous", () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_xxx";
    expect(stripeModeAllowed(false, false)).toBe(true);
    expect(stripeModeAllowed(false, true)).toBe(true);
  });

  test("clés restreintes (rk_) : même règle que les clés secrètes", () => {
    process.env.STRIPE_SECRET_KEY = "rk_live_xxx";
    delete process.env.STRIPE_TEST_SECRET_KEY;
    expect(() => getStripe({ test: true })).toThrow(/STRIPE_TEST_SECRET_KEY/);
    expect(stripeModeAllowed(false, false)).toBe(false);
    expect(stripeModeAllowed(true, false)).toBe(true);
    process.env.STRIPE_SECRET_KEY = "rk_test_xxx";
    expect(stripeModeAllowed(false, false)).toBe(true);
  });
});

test("compte connecté d'un hôtel en Accounts v2 : SaaS — l'hôtel marchand paie ses frais, Stripe porte les pertes, tableau de bord complet", () => {
  const p = connectedAccountParams();
  // Champs v1 interdits (Stripe refuse POST /v1/accounts pour la plateforme).
  expect(p).not.toHaveProperty("type");
  expect(p).not.toHaveProperty("controller");
  expect(p).not.toHaveProperty("capabilities");
  expect(p.dashboard).toBe("full");
  expect(p.defaults).toEqual({ responsibilities: { fees_collector: "stripe", losses_collector: "stripe" } });
  expect(p.configuration).toEqual({ merchant: { capabilities: { card_payments: { requested: true } } } });
  expect(p.configuration).not.toHaveProperty("recipient");
  expect(p.configuration).not.toHaveProperty("customer");
  expect(p.identity).toEqual({ country: "FR" });
  // Plateforme FR : ces champs exigent un account token (validé contre la sandbox le 2026-11-22).
  for (const k of ["display_name", "contact_email", "contact_phone"]) expect(p).not.toHaveProperty(k);
  expect(Object.keys(p.identity ?? {})).toEqual(["country"]);
});

test("lien d'onboarding v2 : config merchant, retours sur le domaine du tenant", () => {
  expect(onboardingLinkParams("acct_123", "https://hotel.example")).toEqual({
    account: "acct_123",
    use_case: {
      type: "account_onboarding",
      account_onboarding: {
        configurations: ["merchant"],
        refresh_url: "https://hotel.example/admin/parametres?stripe=refresh",
        return_url: "https://hotel.example/admin/parametres?stripe=success",
      },
    },
  });
});

test("statut v2 : actif seulement si card_payments est active (pas charges_enabled)", () => {
  const acc = (card?: string, payouts?: string) =>
    ({
      id: "acct_1",
      configuration: card
        ? { merchant: { capabilities: { card_payments: { status: card }, stripe_balance: payouts ? { payouts: { status: payouts } } : undefined } } }
        : null,
    }) as unknown as Stripe.V2.Core.Account;
  expect(connectedAccountStatus(acc("active", "active"))).toEqual({ chargesEnabled: true, payoutsEnabled: true });
  expect(connectedAccountStatus(acc("active"))).toEqual({ chargesEnabled: true, payoutsEnabled: false });
  for (const s of ["pending", "restricted", "unsupported"]) {
    expect(connectedAccountStatus(acc(s, "active")).chargesEnabled).toBe(false);
  }
  // Configuration non incluse dans la réponse (null) : jamais « actif » par défaut.
  expect(connectedAccountStatus(acc())).toEqual({ chargesEnabled: false, payoutsEnabled: false });
});
