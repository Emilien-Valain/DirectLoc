import Stripe from "stripe";

// Créé à la première utilisation : `next build` charge ce module sans STRIPE_SECRET_KEY.
let client: Stripe | undefined;
let testClient: Stripe | undefined;

/**
 * `{ test: true }` : client en mode test (tenant démo), quelle que soit la clé principale.
 * STRIPE_TEST_SECRET_KEY, à défaut STRIPE_SECRET_KEY seulement si c'est une clé test :
 * une clé live ne doit jamais encaisser une réservation démo.
 */
export function getStripe(opts?: { test?: boolean }): Stripe {
  if (opts?.test) {
    const main = process.env.STRIPE_SECRET_KEY;
    const key = process.env.STRIPE_TEST_SECRET_KEY || (main?.startsWith("sk_test_") ? main : undefined);
    if (!key) {
      throw new Error("STRIPE_TEST_SECRET_KEY manquant (la clé principale n'est pas une clé test)");
    }
    return (testClient ??= new Stripe(key));
  }
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error("STRIPE_SECRET_KEY manquant dans les variables d'environnement");
  }
  return (client ??= new Stripe(process.env.STRIPE_SECRET_KEY));
}

/**
 * Un événement live ne touche jamais le tenant démo ; un événement test ne touche un
 * autre tenant que si la plateforme elle-même tourne en clé test (prod actuelle, E2E).
 */
export function stripeModeAllowed(livemode: boolean, demo: boolean): boolean {
  if (demo) return !livemode;
  return livemode || !process.env.STRIPE_SECRET_KEY?.startsWith("sk_live_");
}
