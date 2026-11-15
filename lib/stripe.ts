import Stripe from "stripe";

// Créé à la première utilisation : `next build` charge ce module sans STRIPE_SECRET_KEY.
let client: Stripe | undefined;

export function getStripe(): Stripe {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error("STRIPE_SECRET_KEY manquant dans les variables d'environnement");
  }
  return (client ??= new Stripe(process.env.STRIPE_SECRET_KEY));
}
