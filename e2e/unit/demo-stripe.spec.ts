import { test, expect } from "@playwright/test";
import { getStripe, stripeModeAllowed } from "../../lib/stripe";

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
