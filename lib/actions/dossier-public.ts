"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import { db } from "@/lib/db";
import { bookings, payments, tenants } from "@/db/schema";
import { fullName } from "@/lib/guest-name";
import {
  BookingRulesError,
  CapacityError,
  ExtraUnavailableError,
  RoomUnavailableError,
  saveLines,
  type Admission,
} from "@/lib/booking-intake";
import { admitRoomsInTx, createDossier, RoomRefused } from "@/lib/dossiers";
import { loadRoomCandidates, type LoadedCandidate } from "@/lib/room-combination-candidates";
import { ruleReasons, suggestCombination, validateCombination } from "@/lib/room-combination";
import { combinationErrorMessage, noCombinationMessage } from "@/lib/dossier-messages";
import { grandTotal } from "@/lib/extras";
import { MAX_STRIPE_LINE_ITEMS, openCheckoutOrRollback, roomLineItems } from "@/lib/checkout-lines";
import { CHECKOUT_TTL_MINUTES } from "@/lib/checkout-window";
import { checkRateLimit } from "@/lib/rate-limit";
import { amountBucket, browserDistinctId, captureServer } from "@/lib/analytics";
import { dossierPublicSchema, safeParseFormData } from "@/lib/validation";

/** Montant minimum d'un paiement Stripe en euros. */
const MIN_STRIPE_AMOUNT = 0.5;

/** Une chambre et sa répartition, telle que le formulaire l'affiche. */
export type PlannedRoom = { roomId: string; adults: number; minors: number };

export type DossierBookingState = {
  error: string;
  fieldErrors?: Record<string, string>;
  /** Valeurs saisies, pour ne pas vider le formulaire après une erreur. */
  values: Record<string, string>;
  /** Chambres prises entre-temps (ou refusées) : le formulaire les retire. */
  gone?: string[];
  /** Nouvelle combinaison proposée quand une chambre n'est plus libre. */
  suggestion?: PlannedRoom[];
} | null;

const formatDate = (d: Date) => d.toLocaleDateString("fr-FR", { day: "numeric", month: "long", timeZone: "UTC" });

/**
 * Server action publique : réserver plusieurs chambres en une fois (Dossier, ADR-0012).
 * Le serveur recalcule tout (répartition, prix, options, frais, taxe) : seuls les choix
 * (chambres, personnes, options) viennent du formulaire, jamais un montant.
 *
 * Admission tout ou rien : chaque chambre passe le gate (ADR-0008) dans UNE transaction ;
 * une seule refusée → rien n'est créé et une nouvelle combinaison est proposée.
 * Puis un seul Stripe Checkout (line items par chambre et par option).
 */
export async function createDossierPublic(
  _prev: DossierBookingState,
  formData: FormData,
): Promise<DossierBookingState> {
  const headersList = await headers();
  const tenantId = headersList.get("x-tenant-id");
  if (!tenantId) throw new Error("Tenant non trouvé");

  const values: Record<string, string> = {};
  for (const [k, v] of formData.entries()) if (typeof v === "string") values[k] = v;

  const parsed = safeParseFormData(dossierPublicSchema, formData);
  if ("error" in parsed) return { ...parsed, values };

  // Même budget que le formulaire d'une chambre : un bot ne double pas sa mise.
  const ip = headersList.get("x-forwarded-for")?.split(",")[0]?.trim() ?? headersList.get("x-real-ip") ?? "unknown";
  if (checkRateLimit({ name: "booking-public", limit: 5, windowSec: 600 }, ip).limited) {
    return { error: "Trop de tentatives, réessayez dans quelques minutes.", values };
  }

  const { data } = parsed;
  const { adults, minors, plan } = data;
  const checkIn = new Date(data.checkIn + "T00:00:00.000Z");
  const checkOut = new Date(data.checkOut + "T00:00:00.000Z");
  const guest = {
    guestName: fullName(data.guestFirstName, data.guestLastName),
    guestFirstName: data.guestFirstName,
    guestLastName: data.guestLastName,
    guestEmail: data.guestEmail,
    guestPhone: data.guestPhone,
    guestAddress: data.guestAddress,
    guestCountry: data.guestCountry,
  };

  // 1. La combinaison (chambres libres du tenant, capacités, un adulte par chambre, totaux).
  const candidates = await loadRoomCandidates(tenantId, checkIn, checkOut);
  const nameOf = (id: string) => candidates.find((c) => c.id === id)?.name ?? "Une chambre";
  const check = validateCombination(candidates, plan, adults, minors);
  if (!check.ok) {
    const gone = check.errors.flatMap((e) =>
      e.code === "unknown_room" || e.code === "room_excluded" ? [e.roomId] : [],
    );
    if (gone.length > 0) return goneState(gone, candidates, adults, minors, values);
    return {
      error: [...new Set(check.errors.map((e) => combinationErrorMessage(e, nameOf)))].join(" "),
      values,
    };
  }

  // 2. Admission de chaque chambre + création, dans une seule transaction (tout ou rien).
  type Admitted = { plan: (typeof plan)[number]; admission: Admission };
  let created: { dossierId: string; admitted: Admitted[]; total: number } | null;
  try {
    created = await db.transaction(async (tx) => {
      const byRoom = await admitRoomsInTx(
        tx,
        plan,
        (r) => ({
          roomId: r.roomId,
          tenantId,
          checkIn,
          checkOut,
          guestCount: r.guests,
          childCount: r.minors,
          extraIds: r.extraIds,
          extraQuantities: r.extraQuantities,
        }),
        { enforceRules: true },
      );
      const admitted = plan.map((p) => ({ plan: p, admission: byRoom.get(p.roomId)! }));
      const total = grandTotal(0, admitted.map((a) => ({ total: a.admission.total })));
      // Stripe refuse tout paiement sous 0,50 € : ne rien réserver plutôt que des pending orphelins.
      if (total < MIN_STRIPE_AMOUNT) return null;

      const dossierId = await createDossier(tx, { tenantId, checkIn, checkOut, ...guest });
      for (const { plan: p, admission } of admitted) {
        const [row] = await tx
          .insert(bookings)
          .values({
            tenantId,
            dossierId,
            roomId: p.roomId,
            checkIn,
            checkOut,
            totalPrice: admission.total.toFixed(2),
            status: "pending",
            ...guest,
            guestCount: p.guests,
            childCount: p.minors,
            source: "direct",
          })
          .returning({ id: bookings.id });
        await saveLines(tx, row.id, admission.lines);
      }
      return { dossierId, admitted, total };
    });
  } catch (e) {
    if (!(e instanceof RoomRefused)) throw e;
    const reason = e.reason;
    if (reason instanceof ExtraUnavailableError) return { error: reason.message, values };
    if (
      reason instanceof RoomUnavailableError ||
      reason instanceof BookingRulesError ||
      reason instanceof CapacityError ||
      (reason instanceof Error && reason.message === "Chambre introuvable")
    ) {
      // Chambre prise entre la validation et l'admission : rien n'a été créé (rollback).
      const fresh = await loadRoomCandidates(tenantId, checkIn, checkOut);
      return goneState([e.roomId], fresh, adults, minors, values, nameOf(e.roomId));
    }
    throw reason;
  }

  if (!created) {
    return {
      error:
        "Cette réservation ne peut pas être payée en ligne (moins de 0,50 €). Contactez directement l'établissement.",
      values,
    };
  }
  const { dossierId, admitted, total } = created;

  const [tenant] = await db
    .select({ name: tenants.name, stripeAccountId: tenants.stripeAccountId })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);

  const origin = headersList.get("origin") ?? headersList.get("x-forwarded-proto") + "://" + headersList.get("host");
  const distinctId = await browserDistinctId();
  const nights = admitted[0].admission.breakdown.nights.length;
  const stayLabel = `${nights} nuit${nights > 1 ? "s" : ""}`;
  const dates = `${formatDate(checkIn)} → ${formatDate(checkOut)} · ${tenant?.name ?? ""}`;

  let lineItems = admitted.flatMap(({ plan: p, admission: a }) =>
    roomLineItems({
      name: `${a.room.name} — ${stayLabel}`,
      description: `${dates} · ${p.guests} pers.`,
      accommodation: a.breakdown.totalPrice,
      lines: a.lines,
      prefix: a.room.name,
    }),
  );
  // Au-delà de la limite Stripe : une ligne par chambre, options comprises (le total reste exact).
  if (lineItems.length > MAX_STRIPE_LINE_ITEMS) {
    lineItems = admitted.map(({ plan: p, admission: a }) => ({
      price_data: {
        currency: "eur",
        unit_amount: Math.round(a.total * 100),
        product_data: { name: `${a.room.name} — ${stayLabel}, options comprises`, description: `${dates} · ${p.guests} pers.` },
      },
      quantity: 1,
    }));
  }

  const back = new URLSearchParams({
    checkIn: data.checkIn,
    checkOut: data.checkOut,
    adults: String(adults),
    minors: String(minors),
    rooms: plan.map((p) => p.roomId).join(","),
    cancelled: "true",
  });
  const sessionParams: Stripe.Checkout.SessionCreateParams = {
    mode: "payment",
    payment_method_types: ["card"],
    customer_email: guest.guestEmail,
    line_items: lineItems,
    metadata: { dossierId, tenantId, ...(distinctId && { posthogDistinctId: distinctId }) },
    success_url: `${origin}/reserver/confirmation?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/reserver/chambres?${back}`,
    expires_at: Math.floor(Date.now() / 1000) + CHECKOUT_TTL_MINUTES * 60,
  };

  const session = await openCheckoutOrRollback(tenantId, dossierId, tenant?.stripeAccountId, sessionParams);
  if (!session) {
    return {
      error:
        "Le paiement en ligne est momentanément indisponible. Votre réservation n'a pas été enregistrée : réessayez dans quelques minutes.",
      values,
    };
  }

  await db.insert(payments).values({
    tenantId,
    dossierId,
    stripeSessionId: session.id,
    amount: total.toFixed(2),
    currency: "eur",
    status: "pending",
  });

  captureServer(
    "booking_submitted",
    { surface: "tenant_site", tenant_id: tenantId, nights, rooms: admitted.length, amount_bucket: amountBucket(total) },
    distinctId,
  );
  redirect(session.url!);
}

/** Une ou plusieurs chambres ne sont plus libres : on le dit et on propose une autre combinaison. */
function goneState(
  gone: string[],
  candidates: LoadedCandidate[],
  adults: number,
  minors: number,
  values: Record<string, string>,
  goneName?: string,
): NonNullable<DossierBookingState> {
  const lead = goneName
    ? `« ${goneName} » vient d'être réservée pour ces dates.`
    : gone.length > 1
      ? "Des chambres choisies ne sont plus disponibles pour ces dates."
      : "Une chambre choisie n'est plus disponible pour ces dates.";
  const free = candidates.filter((c) => !gone.includes(c.id));
  const next = suggestCombination(free, adults, minors);
  if (!next.ok) {
    return {
      error: `${lead} Rien n'a été réservé. ${noCombinationMessage(next.reason, adults + minors, adults, next.maxCapacity, ruleReasons(free))}`,
      values,
      gone,
    };
  }
  return {
    error: `${lead} Rien n'a été réservé : voici une nouvelle proposition, vérifiez-la avant de payer.`,
    values,
    gone,
    suggestion: next.rooms.map((r) => ({ roomId: r.roomId, adults: r.adults, minors: r.minors })),
  };
}
