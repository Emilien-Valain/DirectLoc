"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookings, payments, tenants } from "@/db/schema";
import {
  admitBooking,
  BookingRulesError,
  CapacityError,
  ExtraUnavailableError,
  RoomUnavailableError,
  saveLines,
} from "@/lib/booking-intake";
import { getStripe } from "@/lib/stripe";
import { isDemoTenant } from "@/lib/demo";
import { CHECKOUT_TTL_MINUTES } from "@/lib/checkout-window";
import { checkRateLimit } from "@/lib/rate-limit";
import { amountBucket, browserDistinctId, captureServer } from "@/lib/analytics";
import { bookingPublicSchema, safeParseFormData } from "@/lib/validation";
import type Stripe from "stripe";

/** Montant minimum d'un paiement Stripe en euros. */
const MIN_STRIPE_AMOUNT = 0.5;

/**
 * Server action publique pour créer une réservation.
 * Crée un booking pending + un payment pending + une Stripe Checkout Session,
 * puis redirige le client vers la page de paiement Stripe.
 *
 * Les refus (saisie, dates prises entre-temps, règles, Stripe) sont RENDUS au
 * formulaire : une erreur levée serait masquée en production (page générique).
 */
export type PublicBookingState = {
  error: string;
  fieldErrors?: Record<string, string>;
  /** Valeurs saisies, pour ne pas vider le formulaire après une erreur. */
  values: Record<string, string>;
} | null;

export async function createBookingPublic(
  _prev: PublicBookingState,
  formData: FormData,
): Promise<PublicBookingState> {
  const headersList = await headers();
  const tenantId = headersList.get("x-tenant-id");

  if (!tenantId) {
    throw new Error("Tenant non trouvé");
  }

  const values: Record<string, string> = {};
  for (const [k, v] of formData.entries())
    if (typeof v === "string") values[k] = v;

  const parsed = safeParseFormData(bookingPublicSchema, formData);
  if ("error" in parsed) return { ...parsed, values };

  // Le proxy ne limite que /api/* : sans ceci, un bot peut garder toutes les chambres en pending.
  // Compté après la saisie : un client qui corrige ses fautes de frappe ne s'enferme pas dehors.
  const ip = headersList.get("x-forwarded-for")?.split(",")[0]?.trim()
    ?? headersList.get("x-real-ip")
    ?? "unknown";
  if (checkRateLimit({ name: "booking-public", limit: 5, windowSec: 600 }, ip).limited) {
    return { error: "Trop de tentatives, réessayez dans quelques minutes.", values };
  }
  const { data } = parsed;
  const { roomId, guestName, guestEmail, guestCount, childCount } = data;
  const guestPhone = data.guestPhone || null;
  // Cases à cocher multiples : formEntries ne garde que la dernière valeur.
  const extraIds = formData.getAll("extraIds").filter((v): v is string => typeof v === "string");

  const checkIn = new Date(data.checkIn + "T00:00:00.000Z");
  const checkOut = new Date(data.checkOut + "T00:00:00.000Z");

  // Admission : résout+autorise la chambre, contrôle dispo + règles, calcule le
  // prix et insère le booking pending sous verrou (pas de double booking).
  let admitted;
  try {
    admitted = await admitBooking(
      // Fees : tous ceux de la chambre, d'office (feeIds absent). Taxe selon le réglage du tenant.
      { roomId, tenantId, checkIn, checkOut, guestCount, childCount, extraIds },
      { enforceRules: true },
      async (tx, { room, breakdown, lines, total }) => {
        // Stripe refuse tout paiement sous 0,50 € : ne rien réserver plutôt qu'un pending orphelin.
        if (total < MIN_STRIPE_AMOUNT) return null;
        const [row] = await tx
          .insert(bookings)
          .values({
            tenantId,
            roomId,
            checkIn,
            checkOut,
            totalPrice: total.toFixed(2),
            status: "pending",
            guestName,
            guestEmail,
            guestPhone,
            guestCount,
            childCount,
            source: "direct",
          })
          .returning({ id: bookings.id });
        await saveLines(tx, row.id, lines);
        return { room, breakdown, lines, total, bookingId: row.id };
      },
    );
  } catch (e) {
    if (e instanceof RoomUnavailableError) {
      return {
        error:
          "Ces dates viennent d'être réservées. Choisissez d'autres dates.",
        fieldErrors: { checkIn: "Dates indisponibles" },
        values,
      };
    }
    if (e instanceof CapacityError) {
      return { error: e.message, fieldErrors: { guestCount: e.message }, values };
    }
    if (e instanceof ExtraUnavailableError) {
      return { error: e.message, values };
    }
    if (e instanceof BookingRulesError) {
      return { error: e.message, fieldErrors: { checkIn: e.message }, values };
    }
    if (e instanceof Error && e.message === "Chambre introuvable") {
      return {
        error: "Cette chambre n'est plus proposée à la réservation.",
        values,
      };
    }
    throw e;
  }
  if (!admitted) {
    return {
      error:
        "Cette réservation ne peut pas être payée en ligne (moins de 0,50 €). Contactez directement l'établissement.",
      values,
    };
  }
  const { room, breakdown, lines, total, bookingId } = admitted;
  const nights = breakdown.nights.length;
  const totalPrice = total.toFixed(2);

  // Récupérer le tenant (nom + compte Stripe Connect)
  const [tenant] = await db
    .select({ name: tenants.name, stripeAccountId: tenants.stripeAccountId })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);

  const formatDate = (d: Date) =>
    d.toLocaleDateString("fr-FR", { day: "numeric", month: "long" });

  const origin =
    headersList.get("origin") ??
    headersList.get("x-forwarded-proto") + "://" + headersList.get("host");

  // Stripe Connect en direct charge : la session est créée SUR le compte du tenant,
  // qui encaisse 100 % et paie lui-même les frais Stripe (jamais la plateforme).
  const stripeAccountId = tenant?.stripeAccountId;
  // Relayé par Stripe jusqu'au webhook pour rattacher booking_paid au même visiteur.
  const distinctId = await browserDistinctId();

  const sessionParams: Stripe.Checkout.SessionCreateParams = {
    mode: "payment",
    payment_method_types: ["card"],
    customer_email: guestEmail,
    line_items: [
      {
        price_data: {
          currency: "eur",
          unit_amount: Math.round(breakdown.totalPrice * 100),
          product_data: {
            name: `${room.name} — ${nights} nuit${nights > 1 ? "s" : ""}`,
            description: `${formatDate(checkIn)} → ${formatDate(checkOut)} · ${tenant?.name ?? ""}`,
          },
        },
        quantity: 1,
      },
      // Un line item par ligne payante (Stripe refuse un montant nul) : prix unitaire × quantité.
      // La taxe en % a un prix moyen arrondi : envoyée en un seul item pour que Stripe encaisse le total exact.
      ...lines
        .filter((x) => x.total > 0)
        .map((x) => {
          const exact = Math.round(x.unitPrice * 100) * x.quantity === Math.round(x.total * 100);
          return {
            price_data: {
              currency: "eur",
              unit_amount: Math.round((exact ? x.unitPrice : x.total) * 100),
              product_data: { name: exact ? x.label : `${x.label} (${x.quantity} nuitées)` },
            },
            quantity: exact ? x.quantity : 1,
          };
        }),
    ],
    metadata: {
      bookingId,
      tenantId,
      ...(distinctId && { posthogDistinctId: distinctId }),
    },
    success_url: `${origin}/reserver/confirmation?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/reserver/${roomId}?cancelled=true`,
    expires_at: Math.floor(Date.now() / 1000) + CHECKOUT_TTL_MINUTES * 60,
  };

  // Sans session Stripe, aucun événement `expired` n'annulera jamais ce pending :
  // on le retire tout de suite pour ne pas bloquer la chambre indéfiniment.
  let session: Stripe.Checkout.Session;
  try {
    // Démo : mode test sur le compte plateforme, jamais sur un compte connecté.
    const demo = await isDemoTenant(tenantId);
    session = await getStripe({ test: demo }).checkout.sessions.create(
      sessionParams,
      stripeAccountId && !demo ? { stripeAccount: stripeAccountId } : undefined,
    );
  } catch (e) {
    await db.delete(bookings).where(eq(bookings.id, bookingId));
    console.error("Création de la session Stripe impossible:", e);
    return {
      error:
        "Le paiement en ligne est momentanément indisponible. Votre réservation n'a pas été enregistrée : réessayez dans quelques minutes.",
      values,
    };
  }

  // Insérer le payment en DB
  await db.insert(payments).values({
    tenantId,
    bookingId,
    stripeSessionId: session.id,
    amount: totalPrice,
    currency: "eur",
    status: "pending",
  });

  captureServer(
    "booking_submitted",
    { surface: "tenant_site", tenant_id: tenantId, nights, amount_bucket: amountBucket(total) },
    distinctId,
  );
  redirect(session.url!);
}
