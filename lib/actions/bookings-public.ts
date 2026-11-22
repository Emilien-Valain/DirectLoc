"use server";

import { fullName } from "@/lib/guest-name";
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
import { createDossier } from "@/lib/dossiers";
import { CHECKOUT_TTL_MINUTES } from "@/lib/checkout-window";
import { checkRateLimit } from "@/lib/rate-limit";
import { amountBucket, browserDistinctId, captureServer } from "@/lib/analytics";
import { bookingPublicSchema, safeParseFormData } from "@/lib/validation";
import { extraQuantitiesFrom } from "@/lib/extras";
import { openCheckoutOrRollback, roomLineItems } from "@/lib/checkout-lines";
import type Stripe from "stripe";

/** Montant minimum d'un paiement Stripe en euros. */
const MIN_STRIPE_AMOUNT = 0.5;

/**
 * Server action publique pour créer une réservation.
 * Crée un Dossier d'une chambre (booking pending) + un payment pending + une Stripe Checkout Session,
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
  const { roomId, guestEmail, guestCount, childCount, guestPhone, guestAddress, guestCountry } = data;
  const guestFirstName = data.guestFirstName;
  const guestLastName = data.guestLastName;
  const guestName = fullName(guestFirstName, guestLastName);
  // Cases à cocher multiples : formEntries ne garde que la dernière valeur.
  const extraIds = formData.getAll("extraIds").filter((v): v is string => typeof v === "string");
  const extraQuantities = extraQuantitiesFrom(formData.entries());

  const checkIn = new Date(data.checkIn + "T00:00:00.000Z");
  const checkOut = new Date(data.checkOut + "T00:00:00.000Z");

  // Admission : résout+autorise la chambre, contrôle dispo + règles, calcule le
  // prix et insère le booking pending sous verrou (pas de double booking).
  let admitted;
  try {
    admitted = await admitBooking(
      // Fees : tous ceux de la chambre, d'office (feeIds absent). Taxe selon le réglage du tenant.
      { roomId, tenantId, checkIn, checkOut, guestCount, childCount, extraIds, extraQuantities },
      { enforceRules: true },
      async (tx, { room, breakdown, lines, total }) => {
        // Stripe refuse tout paiement sous 0,50 € : ne rien réserver plutôt qu'un pending orphelin.
        if (total < MIN_STRIPE_AMOUNT) return null;
        const guest = { guestName, guestFirstName, guestLastName, guestEmail, guestPhone, guestAddress, guestCountry };
        const dossierId = await createDossier(tx, { tenantId, checkIn, checkOut, ...guest });
        const [row] = await tx
          .insert(bookings)
          .values({
            tenantId,
            dossierId,
            roomId,
            checkIn,
            checkOut,
            totalPrice: total.toFixed(2),
            status: "pending",
            ...guest,
            guestCount,
            childCount,
            source: "direct",
          })
          .returning({ id: bookings.id });
        await saveLines(tx, row.id, lines);
        return { room, breakdown, lines, total, dossierId };
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
  const { room, breakdown, lines, total, dossierId } = admitted;
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
    line_items: roomLineItems({
      name: `${room.name} — ${nights} nuit${nights > 1 ? "s" : ""}`,
      description: `${formatDate(checkIn)} → ${formatDate(checkOut)} · ${tenant?.name ?? ""}`,
      accommodation: breakdown.totalPrice,
      lines,
    }),
    metadata: {
      dossierId,
      tenantId,
      ...(distinctId && { posthogDistinctId: distinctId }),
    },
    success_url: `${origin}/reserver/confirmation?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/reserver/${roomId}?cancelled=true`,
    expires_at: Math.floor(Date.now() / 1000) + CHECKOUT_TTL_MINUTES * 60,
  };

  const checkout = await openCheckoutOrRollback(tenantId, dossierId, stripeAccountId, sessionParams);
  if (!checkout.session) return { error: checkout.error, values };
  const session = checkout.session;

  // Insérer le payment en DB
  await db.insert(payments).values({
    tenantId,
    dossierId,
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
