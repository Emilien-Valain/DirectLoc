import type Stripe from "stripe";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookings, dossiers } from "@/db/schema";
import { getStripe } from "@/lib/stripe";
import { isDemoTenant } from "@/lib/demo";
import type { StayLine } from "@/lib/extras";

type LineItem = Stripe.Checkout.SessionCreateParams.LineItem;

/** Stripe refuse plus de 100 line items par session en mode paiement. */
export const MAX_STRIPE_LINE_ITEMS = 100;

/**
 * Line items Stripe d'une chambre : l'hébergement, puis une ligne par ligne payante
 * (Stripe refuse un montant nul) : prix unitaire × quantité. La taxe en % a un prix moyen
 * arrondi : envoyée en un seul item pour que Stripe encaisse le total exact.
 * `prefix` (nom de la chambre) distingue les options de chaque chambre d'une même réservation.
 */
export function roomLineItems({
  name,
  description,
  accommodation,
  lines,
  prefix,
}: {
  name: string;
  description: string;
  accommodation: number;
  lines: StayLine[];
  prefix?: string;
}): LineItem[] {
  return [
    {
      price_data: {
        currency: "eur",
        unit_amount: Math.round(accommodation * 100),
        product_data: { name, description },
      },
      quantity: 1,
    },
    ...lines
      .filter((x) => x.total > 0)
      .map((x) => {
        const exact = Math.round(x.unitPrice * 100) * x.quantity === Math.round(x.total * 100);
        const label = exact ? x.label : `${x.label} (${x.quantity} nuitées)`;
        return {
          price_data: {
            currency: "eur",
            unit_amount: Math.round((exact ? x.unitPrice : x.total) * 100),
            product_data: { name: prefix ? `${prefix} · ${label}` : label },
          },
          quantity: exact ? x.quantity : 1,
        };
      }),
  ];
}

export const ONLINE_PAYMENT_NOT_ENABLED =
  "Le paiement en ligne n'est pas encore activé pour cet établissement. Contactez-le directement pour réserver.";
export const ONLINE_PAYMENT_UNAVAILABLE =
  "Le paiement en ligne est momentanément indisponible. Votre réservation n'a pas été enregistrée : réessayez dans quelques minutes.";

/**
 * Ouvre la session Checkout d'un Dossier (Stripe Connect en direct charge : sur le compte du
 * tenant, qui encaisse 100 % ; démo : mode test sur le compte plateforme). Un tenant non démo
 * sans compte connecté ne peut PAS encaisser : jamais de session sur le compte plateforme
 * (l'argent du voyageur irait à la plateforme au lieu de l'établissement).
 * Si on ne peut pas ouvrir la session, aucun événement `expired` n'annulera jamais les
 * réservations pending : on retire tout de suite le Dossier et ses réservations, puis on rend
 * `{ error }` (message voyageur prêt à afficher).
 */
export async function openCheckoutOrRollback(
  tenantId: string,
  dossierId: string,
  stripeAccountId: string | null | undefined,
  params: Stripe.Checkout.SessionCreateParams,
): Promise<{ session: Stripe.Checkout.Session; error?: undefined } | { session?: undefined; error: string }> {
  const rollback = () =>
    db.transaction(async (tx) => {
      await tx.delete(bookings).where(eq(bookings.dossierId, dossierId));
      await tx.delete(dossiers).where(eq(dossiers.id, dossierId));
    });
  let demo = false;
  try {
    demo = await isDemoTenant(tenantId);
    if (!demo && !stripeAccountId) {
      await rollback();
      console.error(`Paiement en ligne refusé : le tenant ${tenantId} n'a pas de compte Stripe connecté.`);
      return { error: ONLINE_PAYMENT_NOT_ENABLED };
    }
    const session = await getStripe({ test: demo }).checkout.sessions.create(
      params,
      stripeAccountId && !demo ? { stripeAccount: stripeAccountId } : undefined,
    );
    return { session };
  } catch (e) {
    await rollback();
    console.error("Création de la session Stripe impossible:", e);
    return { error: ONLINE_PAYMENT_UNAVAILABLE };
  }
}
