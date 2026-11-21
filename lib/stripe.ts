import Stripe from "stripe";

// Créé à la première utilisation : `next build` charge ce module sans STRIPE_SECRET_KEY.
let client: Stripe | undefined;
let testClient: Stripe | undefined;

/**
 * E2E seulement : STRIPE_API_BASE (ex. http://localhost:3995) envoie les appels de l'API
 * Stripe vers un faux serveur local (e2e/helpers/fake-stripe.ts). Jamais posé en production.
 */
function apiOverride(): Stripe.StripeConfig {
  const base = process.env.STRIPE_API_BASE;
  if (!base) return {};
  const u = new URL(base);
  return {
    host: u.hostname,
    port: Number(u.port || (u.protocol === "https:" ? 443 : 80)),
    protocol: u.protocol === "https:" ? "https" : "http",
    maxNetworkRetries: 0,
  };
}

/** Clé secrète (`sk_`) ou restreinte (`rk_`) : seul le mode compte. */
const isLiveKey = (key?: string) => !!key && /^(sk|rk)_live_/.test(key);
const isTestKey = (key?: string) => !!key && /^(sk|rk)_test_/.test(key);

/**
 * `{ test: true }` : client en mode test (tenant démo), quelle que soit la clé principale.
 * STRIPE_TEST_SECRET_KEY, à défaut STRIPE_SECRET_KEY seulement si c'est une clé test :
 * une clé live ne doit jamais encaisser une réservation démo.
 */
export function getStripe(opts?: { test?: boolean }): Stripe {
  if (opts?.test) {
    const main = process.env.STRIPE_SECRET_KEY;
    const key = process.env.STRIPE_TEST_SECRET_KEY || (isTestKey(main) ? main : undefined);
    if (!key) {
      throw new Error("STRIPE_TEST_SECRET_KEY manquant (la clé principale n'est pas une clé test)");
    }
    return (testClient ??= new Stripe(key, apiOverride()));
  }
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error("STRIPE_SECRET_KEY manquant dans les variables d'environnement");
  }
  return (client ??= new Stripe(process.env.STRIPE_SECRET_KEY, apiOverride()));
}

/**
 * Un événement live ne touche jamais le tenant démo ; un événement test ne touche un
 * autre tenant que si la plateforme elle-même tourne en clé test (prod actuelle, E2E).
 */
export function stripeModeAllowed(livemode: boolean, demo: boolean): boolean {
  if (demo) return !livemode;
  return livemode || !isLiveKey(process.env.STRIPE_SECRET_KEY);
}
