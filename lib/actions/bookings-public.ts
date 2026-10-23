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
  RoomUnavailableError,
} from "@/lib/booking-intake";
import { stripe } from "@/lib/stripe";
import { checkRateLimit } from "@/lib/rate-limit";
import { bookingPublicSchema, safeParseFormData } from "@/lib/validation";
import type Stripe from "stripe";

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

  // Le proxy ne limite que /api/* : sans ceci, un bot peut garder toutes les chambres en pending.
  const ip = headersList.get("x-forwarded-for")?.split(",")[0]?.trim()
    ?? headersList.get("x-real-ip")
    ?? "unknown";
  if (checkRateLimit({ name: "booking-public", limit: 5, windowSec: 600 }, ip).limited) {
    return { error: "Trop de tentatives, réessayez dans quelques minutes.", values };
  }

  const parsed = safeParseFormData(bookingPublicSchema, formData);
  if ("error" in parsed) return { ...parsed, values };
  const { data } = parsed;
  const { roomId, guestName, guestEmail, guestCount } = data;
  const guestPhone = data.guestPhone || null;

  const checkIn = new Date(data.checkIn + "T00:00:00.000Z");
  const checkOut = new Date(data.checkOut + "T00:00:00.000Z");

  // Admission : résout+autorise la chambre, contrôle dispo + règles, calcule le
  // prix et insère le booking pending sous verrou (pas de double booking).
  let admitted;
  try {
    admitted = await admitBooking(
      { roomId, tenantId, checkIn, checkOut, guestCount },
      { enforceRules: true },
      async (tx, { room, breakdown }) => {
        const [row] = await tx
          .insert(bookings)
          .values({
            tenantId,
            roomId,
            checkIn,
            checkOut,
            totalPrice: breakdown.totalPrice.toFixed(2),
            status: "pending",
            guestName,
            guestEmail,
            guestPhone,
            guestCount,
            source: "direct",
          })
          .returning({ id: bookings.id });
        return { room, breakdown, bookingId: row.id };
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
  const { room, breakdown, bookingId } = admitted;
  const nights = breakdown.nights.length;
  const totalPrice = breakdown.totalPrice.toFixed(2);

  // Récupérer le tenant (nom + compte Stripe Connect)
  const [tenant] = await db
    .select({ name: tenants.name, stripeAccountId: tenants.stripeAccountId })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);

  // Créer la Stripe Checkout Session
  const amountCents = Math.round(parseFloat(totalPrice) * 100);

  const formatDate = (d: Date) =>
    d.toLocaleDateString("fr-FR", { day: "numeric", month: "long" });

  const origin =
    headersList.get("origin") ??
    headersList.get("x-forwarded-proto") + "://" + headersList.get("host");

  // Stripe Connect en direct charge : la session est créée SUR le compte du tenant,
  // qui encaisse 100 % et paie lui-même les frais Stripe (jamais la plateforme).
  const stripeAccountId = tenant?.stripeAccountId;

  const sessionParams: Stripe.Checkout.SessionCreateParams = {
    mode: "payment",
    payment_method_types: ["card"],
    customer_email: guestEmail,
    line_items: [
      {
        price_data: {
          currency: "eur",
          unit_amount: amountCents,
          product_data: {
            name: `${room.name} — ${nights} nuit${nights > 1 ? "s" : ""}`,
            description: `${formatDate(checkIn)} → ${formatDate(checkOut)} · ${tenant?.name ?? ""}`,
          },
        },
        quantity: 1,
      },
    ],
    metadata: {
      bookingId,
      tenantId,
    },
    success_url: `${origin}/reserver/confirmation?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/reserver/${roomId}?cancelled=true`,
    expires_at: Math.floor(Date.now() / 1000) + 1800, // 30 minutes
  };

  // Sans session Stripe, aucun événement `expired` n'annulera jamais ce pending :
  // on le retire tout de suite pour ne pas bloquer la chambre indéfiniment.
  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.create(
      sessionParams,
      stripeAccountId ? { stripeAccount: stripeAccountId } : undefined,
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

  redirect(session.url!);
}
