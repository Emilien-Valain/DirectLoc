import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookingLines, bookings, disputes, dossiers, payments, refunds, tenants } from "@/db/schema";
import { admitInTx, priceStay, saveLines, type AdmitInput, type Tx } from "@/lib/booking-intake";
import { admitRoomsInTx } from "@/lib/dossiers";
import { openCheckoutDeadline } from "@/lib/checkout-window";
import { parisToday } from "@/lib/date-windows";
import { isStayTooLong, isUuid, STAY_TOO_LONG_MESSAGE } from "@/lib/validation";
import { getStripe } from "@/lib/stripe";
import { isDemoTenant } from "@/lib/demo";
import { formatEuros } from "@/lib/utils";
import { hasOpenDispute, refundStatusFromStripe, type RefundStatus } from "@/lib/refunds";
import { cents } from "@/lib/refund-amounts";

/**
 * Ce que l'hôte fait sur un Dossier entier depuis sa fiche (ADR-0012) : annuler une chambre
 * ou tout le Dossier, marquer réglé, changer les dates de toutes les chambres, ajouter une chambre.
 *
 * Le tenant est un argument explicite et filtre CHAQUE requête : un Dossier d'un autre tenant
 * est introuvable, rien ne bouge chez lui (testé par `e2e/unit/dossier-isolation.spec.ts`).
 * Les server actions (`lib/actions/bookings.ts`) n'ajoutent que la session, le cache et la redirection.
 */

type Conn = Tx | typeof db;

/** Refus attendu (message prêt à afficher, champ concerné le cas échéant) : rien n'a été écrit. */
export class DossierActionError extends Error {
  constructor(
    message: string,
    readonly field?: "checkIn" | "checkOut" | "roomId",
  ) {
    super(message);
    this.name = "DossierActionError";
  }
}

const ACTIVE = ["pending", "confirmed"] as const;

/** Annule les réservations actives d'un Dossier du tenant ; `only` = une chambre. Retourne celles annulées. */
export async function cancelDossierRooms(tenantId: string, dossierId: string, only?: string): Promise<string[]> {
  if (!isUuid(dossierId) || (only !== undefined && !isUuid(only))) return [];
  const rows = await db
    .update(bookings)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(
      and(
        eq(bookings.dossierId, dossierId),
        eq(bookings.tenantId, tenantId),
        inArray(bookings.status, [...ACTIVE]),
        only ? eq(bookings.id, only) : undefined,
      ),
    )
    .returning({ id: bookings.id });
  return rows.map((r) => r.id);
}

/** Règlement hors ligne de tout le Dossier : chaque chambre non annulée. Retourne les chambres touchées. */
export async function setDossierPaidState(tenantId: string, dossierId: string, paid: boolean): Promise<string[]> {
  if (!isUuid(dossierId)) return [];
  const rows = await db
    .update(bookings)
    .set({ paidAt: paid ? new Date() : null, updatedAt: new Date() })
    .where(
      and(
        eq(bookings.dossierId, dossierId),
        eq(bookings.tenantId, tenantId),
        inArray(bookings.status, ["pending", "confirmed", "completed"]),
      ),
    )
    .returning({ id: bookings.id });
  return rows.map((r) => r.id);
}

type StayBooking = { id: string; roomId: string; guestCount: number; childCount: number };

/**
 * La même réservation sur d'autres dates : ses options et frais gardent leur prix figé
 * (quantités bornées par le nouveau séjour), l'exonération de taxe reste ; l'hébergement et
 * la taxe sont recalculés — comme « Modifier » une réservation sans prix convenu (ADR-0010/0011).
 */
async function sameStayOn(conn: Conn, tenantId: string, b: StayBooking, checkIn: Date, checkOut: Date): Promise<AdmitInput> {
  const lines = await conn
    .select({ id: bookingLines.id, kind: bookingLines.kind, exempt: bookingLines.exempt })
    .from(bookingLines)
    .where(eq(bookingLines.bookingId, b.id));
  return {
    roomId: b.roomId,
    tenantId,
    checkIn,
    checkOut,
    guestCount: b.guestCount,
    childCount: b.childCount,
    extraIds: lines.filter((l) => l.kind === "extra").map((l) => l.id),
    feeIds: lines.filter((l) => l.kind === "fee").map((l) => l.id),
    waiveTax: lines.some((l) => l.kind === "tax" && l.exempt),
  };
}

/**
 * Dossier du tenant verrouillé jusqu'au commit (deux modifications du même Dossier passent
 * l'une après l'autre), ses réservations, et le refus des cas où il ne se modifie pas.
 */
async function lockEditableDossier(tx: Tx, tenantId: string, dossierId: string) {
  const [dossier] = await tx
    .select()
    .from(dossiers)
    .where(and(eq(dossiers.id, dossierId), eq(dossiers.tenantId, tenantId)))
    .for("update");
  if (!dossier) throw new DossierActionError("Dossier introuvable.");
  const all = await tx
    .select({
      id: bookings.id,
      roomId: bookings.roomId,
      status: bookings.status,
      guestCount: bookings.guestCount,
      childCount: bookings.childCount,
    })
    .from(bookings)
    .where(and(eq(bookings.dossierId, dossierId), eq(bookings.tenantId, tenantId)))
    .orderBy(asc(bookings.createdAt), asc(bookings.id));
  const active = all.filter((b) => b.status === "pending" || b.status === "confirmed");
  if (active.length === 0 || all.some((b) => b.status === "completed")) {
    throw new DossierActionError("Ce Dossier est annulé ou terminé : il ne se modifie plus.");
  }
  const [payment] = await tx
    .select({ status: payments.status, createdAt: payments.createdAt })
    .from(payments)
    .where(and(eq(payments.dossierId, dossierId), eq(payments.tenantId, tenantId)))
    .orderBy(desc(payments.createdAt))
    .limit(1);
  // Le montant du Checkout est figé : rien ne bouge pendant que le client paie.
  if (openCheckoutDeadline(payment)) {
    throw new DossierActionError("Le client est en train de payer en ligne : réessayez dans une demi-heure au plus.");
  }
  return { dossier, active };
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Nouvelles dates pour TOUT le Dossier (ADR-0012 : mêmes dates pour toutes les chambres).
 * Chaque chambre non annulée repasse le gate d'admission (ADR-0008) dans UNE transaction,
 * sa propre réservation exclue des Holds, « Forcer » (`force`) pour toutes : une chambre
 * refusée → `RoomRefused`, rien ne bouge. Prix de chaque chambre recalculé (`sameStayOn`).
 * Arrivée changée → rappel et remerciement du Dossier à renvoyer (marqueurs remis à NULL).
 * Retourne les réservations déplacées (vide si les dates n'ont pas changé).
 */
export async function changeDossierDates(
  tenantId: string,
  dossierId: string,
  { checkIn, checkOut, force = false }: { checkIn: Date; checkOut: Date; force?: boolean },
): Promise<string[]> {
  if (!isUuid(dossierId)) throw new DossierActionError("Dossier introuvable.");
  if (isNaN(checkIn.getTime()) || isNaN(checkOut.getTime())) throw new DossierActionError("Date invalide", "checkIn");
  if (checkOut <= checkIn) throw new DossierActionError("La date de départ doit être après la date d'arrivée", "checkOut");
  if (isStayTooLong(checkIn, checkOut)) throw new DossierActionError(STAY_TOO_LONG_MESSAGE, "checkOut");

  return db.transaction(async (tx) => {
    const { dossier, active } = await lockEditableDossier(tx, tenantId, dossierId);
    const arrivalChanged = new Date(dossier.checkIn).getTime() !== checkIn.getTime();
    const departureChanged = new Date(dossier.checkOut).getTime() !== checkOut.getTime();
    if (!arrivalChanged && !departureChanged) return [];
    // Une régularisation passée se saisit à la création ; déplacer un séjour dans le passé, non.
    if (arrivalChanged && isoDay(checkIn) < parisToday()) {
      throw new DossierActionError("La date d'arrivée est déjà passée", "checkIn");
    }

    const stays = new Map<string, AdmitInput>();
    for (const b of active) stays.set(b.id, await sameStayOn(tx, tenantId, b, checkIn, checkOut));
    const admitted = await admitRoomsInTx(
      tx,
      active,
      (b) => stays.get(b.id)!,
      (b) => ({ allowOverlap: force, excludeBookingId: b.id }),
    );
    for (const b of active) {
      const { lines, total } = admitted.get(b.roomId)!;
      const moved = await tx
        .update(bookings)
        .set({ checkIn, checkOut, totalPrice: total.toFixed(2), updatedAt: new Date() })
        // Annulée entre-temps (l'annulation ne prend pas le verrou du Dossier) : tout est défait.
        .where(and(eq(bookings.id, b.id), eq(bookings.tenantId, tenantId), inArray(bookings.status, [...ACTIVE])))
        .returning({ id: bookings.id });
      if (moved.length === 0) throw new DossierActionError("Une chambre vient d'être annulée : rechargez la fiche.");
      await saveLines(tx, b.id, lines);
    }
    await tx
      .update(dossiers)
      .set({
        checkIn,
        checkOut,
        updatedAt: new Date(),
        ...(arrivalChanged ? { reminderSentAt: null, thankYouSentAt: null } : { thankYouSentAt: null }),
      })
      .where(and(eq(dossiers.id, dossierId), eq(dossiers.tenantId, tenantId)));
    return active.map((b) => b.id);
  });
}

/** Total de chaque chambre active si le Dossier passait à ces dates (devis du formulaire, même calcul). */
export async function quoteDossierDatesFor(tenantId: string, dossierId: string, checkIn: Date, checkOut: Date) {
  if (!isUuid(dossierId) || isNaN(checkIn.getTime()) || isNaN(checkOut.getTime())) return null;
  if (checkOut <= checkIn || isStayTooLong(checkIn, checkOut)) return null;
  const active = await db
    .select({ id: bookings.id, roomId: bookings.roomId, guestCount: bookings.guestCount, childCount: bookings.childCount })
    .from(bookings)
    .where(and(eq(bookings.dossierId, dossierId), eq(bookings.tenantId, tenantId), inArray(bookings.status, [...ACTIVE])))
    .orderBy(asc(bookings.createdAt), asc(bookings.id));
  if (active.length === 0) return null;
  const totals: { bookingId: string; total: number }[] = [];
  for (const b of active) {
    const price = await priceStay(db, { ...(await sameStayOn(db, tenantId, b, checkIn, checkOut)), bookingId: b.id });
    totals.push({ bookingId: b.id, total: price.total });
  }
  return { nights: Math.round((checkOut.getTime() - checkIn.getTime()) / 86_400_000), totals };
}

export type AddRoomInput = {
  roomId: string;
  guestCount: number;
  childCount?: number;
  extraIds?: string[];
  extraQuantities?: Record<string, number>;
  feeIds?: string[];
  waiveTax?: boolean;
  force?: boolean;
};

/**
 * Ajoute une chambre à un Dossier existant : mêmes dates, voyageur recopié du Dossier,
 * admission (ADR-0008, « Forcer » possible) dans la transaction qui insère. Statut du Dossier :
 * `confirmed` dès qu'une chambre l'est (sinon `pending`, et le webhook décide pour toutes).
 * Refus : Dossier annulé/terminé/en paiement, chambre déjà dans le Dossier ; les refus du gate
 * (chambre d'un autre tenant, occupée, capacité…) remontent tels quels. Retourne la réservation.
 */
export async function addRoomToDossier(tenantId: string, dossierId: string, input: AddRoomInput): Promise<string> {
  if (!isUuid(dossierId)) throw new DossierActionError("Dossier introuvable.");
  if (!isUuid(input.roomId)) throw new DossierActionError("Choisissez une chambre", "roomId");
  return db.transaction(async (tx) => {
    const { dossier, active } = await lockEditableDossier(tx, tenantId, dossierId);
    if (active.some((b) => b.roomId === input.roomId)) {
      throw new DossierActionError("Cette chambre est déjà dans le Dossier.", "roomId");
    }
    const { lines, total } = await admitInTx(
      tx,
      {
        roomId: input.roomId,
        tenantId,
        checkIn: dossier.checkIn,
        checkOut: dossier.checkOut,
        guestCount: input.guestCount,
        childCount: input.childCount ?? 0,
        extraIds: input.extraIds ?? [],
        extraQuantities: input.extraQuantities,
        feeIds: input.feeIds ?? [],
        waiveTax: input.waiveTax,
      },
      { allowOverlap: input.force ?? false },
    );
    const [row] = await tx
      .insert(bookings)
      .values({
        tenantId,
        dossierId,
        roomId: input.roomId,
        checkIn: dossier.checkIn,
        checkOut: dossier.checkOut,
        totalPrice: total.toFixed(2),
        guestName: dossier.guestName,
        guestFirstName: dossier.guestFirstName,
        guestLastName: dossier.guestLastName,
        guestEmail: dossier.guestEmail,
        guestPhone: dossier.guestPhone,
        guestAddress: dossier.guestAddress,
        guestCountry: dossier.guestCountry,
        guestCount: input.guestCount,
        childCount: input.childCount ?? 0,
        status: active.some((b) => b.status === "confirmed") ? "confirmed" : "pending",
        source: "manual",
      })
      .returning({ id: bookings.id });
    await saveLines(tx, row.id, lines);
    return row.id;
  });
}

export type RefundInput = {
  /** Centimes, > 0 (déjà parsé : `parseRefundAmount`). */
  amountCents: number;
  /** Une soumission de formulaire = un uuid : la rejouer ne rembourse pas deux fois. */
  requestId: string;
  reason?: string | null;
  /** Chambre dont l'annulation déclenche le remboursement ; ignorée si elle n'est pas dans ce Dossier. */
  bookingId?: string | null;
  userId?: string | null;
};

export const REFUND_REASON_MAX = 500;

/** Ce qu'on peut rembourser sur le Dossier du tenant, ou pourquoi on ne peut pas (message prêt à afficher). */
async function refundablePayment(conn: Conn, tenantId: string, dossierId: string) {
  const [payment] = await conn
    .select({ id: payments.id, status: payments.status, amount: payments.amount, stripePaymentId: payments.stripePaymentId })
    .from(payments)
    .where(and(eq(payments.dossierId, dossierId), eq(payments.tenantId, tenantId)))
    .orderBy(desc(payments.createdAt))
    .limit(1);
  if (!payment || payment.status !== "paid" || !payment.stripePaymentId) {
    throw new DossierActionError(
      "Aucun paiement en ligne à rembourser : un règlement hors ligne se rembourse directement avec le client.",
    );
  }
  if (await hasOpenDispute(tenantId, dossierId)) {
    throw new DossierActionError("Litige en cours sur ce paiement : répondez-y d'abord, le remboursement est bloqué.");
  }
  const done = await conn
    .select({ amount: refunds.amount, status: refunds.status })
    .from(refunds)
    .where(and(eq(refunds.paymentId, payment.id), eq(refunds.tenantId, tenantId)));
  // Litige perdu : la banque a repris ce montant, il n'est plus remboursable.
  const lost = await conn
    .select({ amount: disputes.amount })
    .from(disputes)
    .where(and(eq(disputes.paymentId, payment.id), eq(disputes.tenantId, tenantId), eq(disputes.status, "lost")));
  const refunded =
    done.filter((r) => r.status !== "failed").reduce((n, r) => n + cents(r.amount), 0) + lost.reduce((n, d) => n + cents(d.amount), 0);
  return { payment, stripePaymentId: payment.stripePaymentId, refundable: Math.max(0, cents(payment.amount) - refunded) };
}

/**
 * Vérification sans écrire ni verrouiller (avant d'annuler une chambre avec remboursement :
 * un montant impossible garde le dialog ouvert et n'annule rien). Le plafond fait foi dans
 * `refundDossierPayment`, sous verrou.
 */
export async function checkRefund(tenantId: string, dossierId: string, amountCents: number): Promise<void> {
  if (!isUuid(dossierId)) throw new DossierActionError("Dossier introuvable.");
  const [dossier] = await db
    .select({ id: dossiers.id })
    .from(dossiers)
    .where(and(eq(dossiers.id, dossierId), eq(dossiers.tenantId, tenantId)));
  if (!dossier) throw new DossierActionError("Dossier introuvable.");
  const { refundable } = await refundablePayment(db, tenantId, dossierId);
  assertWithinCap(amountCents, refundable);
}

function assertWithinCap(amountCents: number, refundable: number) {
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw new DossierActionError("Saisissez un montant supérieur à 0 €.");
  if (refundable <= 0) throw new DossierActionError("Ce paiement est déjà entièrement remboursé.");
  if (amountCents > refundable) {
    throw new DossierActionError(`Le montant dépasse ce qui reste remboursable (${formatEuros(refundable / 100)} au plus).`);
  }
}

/** Erreur Stripe → message hôte. Rien n'a été enregistré ni remboursé. */
function stripeRefundError(e: unknown): DossierActionError {
  const err = e as { type?: string; message?: string };
  console.error("Remboursement Stripe impossible:", e);
  if (err?.type === "StripeConnectionError" || err?.type === "StripeAPIError" || !err?.type) {
    return new DossierActionError("Stripe est injoignable pour le moment : rien n'a été remboursé. Réessayez dans un instant.");
  }
  return new DossierActionError(
    `Stripe a refusé le remboursement${err.message ? ` (« ${err.message} »)` : ""} : rien n'a été remboursé.`,
  );
}

/**
 * Rembourse une partie ou la totalité du paiement en ligne d'un Dossier du tenant (PRD
 * Remboursements). Direct charge : le Refund est créé SUR le compte connecté de l'hôtel
 * (`stripeAccount`) ; démo : mode test sur le compte plateforme, sans compte connecté.
 *
 * Dans UNE transaction, Dossier verrouillé (deux remboursements du même Dossier passent l'un
 * après l'autre) : plafond = payé − remboursements non échoués (en cours compris) ; puis appel
 * Stripe (idempotency key = la soumission) ; la ligne n'est écrite que si Stripe a accepté.
 * Stripe en erreur → `DossierActionError`, rien en base. Une soumission rejouée renvoie le
 * remboursement déjà fait (`created: false`).
 * Refus : Dossier d'un autre tenant, pas de paiement en ligne (réglé hors ligne), litige ouvert,
 * montant ≤ 0 ou au-delà du restant, hôtel sans compte Stripe connecté.
 */
export async function refundDossierPayment(
  tenantId: string,
  dossierId: string,
  input: RefundInput,
): Promise<{ id: string; amount: number; status: RefundStatus; created: boolean }> {
  if (!isUuid(dossierId)) throw new DossierActionError("Dossier introuvable.");
  if (!isUuid(input.requestId)) throw new DossierActionError("Formulaire expiré : rechargez la page.");
  const reason = input.reason?.trim().slice(0, REFUND_REASON_MAX) || null;
  const idempotencyKey = `refund_${dossierId}_${input.requestId}`;

  return db.transaction(async (tx) => {
    const [dossier] = await tx
      .select({ id: dossiers.id })
      .from(dossiers)
      .where(and(eq(dossiers.id, dossierId), eq(dossiers.tenantId, tenantId)))
      .for("update");
    if (!dossier) throw new DossierActionError("Dossier introuvable.");

    const [replay] = await tx
      .select({ id: refunds.id, amount: refunds.amount, status: refunds.status })
      .from(refunds)
      .where(and(eq(refunds.idempotencyKey, idempotencyKey), eq(refunds.tenantId, tenantId)));
    if (replay) return { id: replay.id, amount: parseFloat(replay.amount), status: replay.status, created: false };

    const { payment, stripePaymentId, refundable } = await refundablePayment(tx, tenantId, dossierId);
    assertWithinCap(input.amountCents, refundable);

    let bookingId: string | null = null;
    if (input.bookingId && isUuid(input.bookingId)) {
      const [b] = await tx
        .select({ id: bookings.id })
        .from(bookings)
        .where(and(eq(bookings.id, input.bookingId), eq(bookings.dossierId, dossierId), eq(bookings.tenantId, tenantId)));
      bookingId = b?.id ?? null;
    }

    const demo = await isDemoTenant(tenantId);
    const [tenant] = await tx.select({ stripeAccountId: tenants.stripeAccountId }).from(tenants).where(eq(tenants.id, tenantId));
    if (!demo && !tenant?.stripeAccountId) {
      throw new DossierActionError("Votre compte Stripe n'est plus connecté : reconnectez-le dans Paramètres pour rembourser.");
    }

    let refund;
    try {
      refund = await getStripe({ test: demo }).refunds.create(
        {
          payment_intent: stripePaymentId,
          amount: input.amountCents,
          metadata: { dossierId, tenantId, ...(bookingId ? { bookingId } : {}) },
        },
        { idempotencyKey, ...(demo ? {} : { stripeAccount: tenant!.stripeAccountId! }) },
      );
    } catch (e) {
      throw stripeRefundError(e);
    }

    const status = refundStatusFromStripe(refund.status);
    const [row] = await tx
      .insert(refunds)
      .values({
        tenantId,
        dossierId,
        bookingId,
        paymentId: payment.id,
        amount: (input.amountCents / 100).toFixed(2),
        reason,
        status,
        stripeRefundId: refund.id,
        idempotencyKey,
        failureReason: status === "failed" ? (refund.failure_reason ?? null) : null,
        createdBy: input.userId ?? null,
      })
      // Le webhook a pu écrire la ligne avant nous (course) : on la complète au lieu d'échouer.
      .onConflictDoUpdate({
        target: refunds.stripeRefundId,
        set: { bookingId, reason, createdBy: input.userId ?? null },
      })
      .returning({ id: refunds.id });
    return { id: row.id, amount: input.amountCents / 100, status, created: true };
  });
}
