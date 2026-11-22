import type Stripe from "stripe";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookings, disputes, dossiers, payments, refunds, rooms, tenants } from "@/db/schema";
import { isDemoTenant } from "@/lib/demo";
import { getStripe } from "@/lib/stripe";
import { isUuid } from "@/lib/validation";
import {
  EVIDENCE_FIELDS,
  canRespond,
  cleanEvidence,
  defaultEvidence,
  disputeIsFinal,
  disputeIsOpen,
  nextDisputeStatus,
  type Evidence,
} from "@/lib/dispute-evidence";

/**
 * Litiges (chargebacks) d'un paiement en ligne (PRD « Remboursements et litiges », issue 04).
 * Créés et tenus à jour par le webhook `charge.dispute.*` (`lib/dispute-sync.ts`) ; l'hôte répond
 * (preuves texte, brouillon puis envoi définitif) ou accepte depuis l'admin. Direct charges : le
 * litige vit sur le compte connecté de l'hôtel (`stripeAccount`) ; démo : mode test, plateforme.
 * Toutes les fonctions prennent le tenant en premier : un litige d'un autre tenant est introuvable.
 */

export type DisputeRow = typeof disputes.$inferSelect;

export class DisputeActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DisputeActionError";
  }
}

/** Litiges du Dossier, du plus ancien au plus récent. */
export async function getDossierDisputes(tenantId: string, dossierId: string): Promise<DisputeRow[]> {
  return db
    .select()
    .from(disputes)
    .where(and(eq(disputes.dossierId, dossierId), eq(disputes.tenantId, tenantId)))
    .orderBy(asc(disputes.createdAt), asc(disputes.id));
}

/** Montant repris par la banque (litiges perdus), en euros : compté comme remboursé dans l'encaissé net. */
export function lostDisputeTotal(rows: { amount: string; status: string }[]): number {
  return rows.filter((d) => d.status === "lost").reduce((n, d) => n + Math.round(parseFloat(d.amount) * 100), 0) / 100;
}

/** Dossiers (parmi `dossierIds`) qui ont un litige ouvert : marque dans la liste des réservations. */
export async function dossiersWithOpenDispute(tenantId: string, dossierIds: string[]): Promise<Set<string>> {
  const ids = [...new Set(dossierIds)];
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ dossierId: disputes.dossierId, status: disputes.status })
    .from(disputes)
    .where(and(eq(disputes.tenantId, tenantId), inArray(disputes.dossierId, ids)));
  return new Set(rows.filter((r) => disputeIsOpen(r.status)).map((r) => r.dossierId));
}

/** Le litige du tenant, avec son Dossier ; `undefined` si introuvable pour ce tenant. */
export async function getDisputeForAdmin(tenantId: string, disputeId: string) {
  if (!isUuid(disputeId)) return undefined;
  const [row] = await db
    .select({ dispute: disputes, dossierTenantId: dossiers.tenantId })
    .from(disputes)
    .innerJoin(dossiers, eq(dossiers.id, disputes.dossierId))
    .where(and(eq(disputes.id, disputeId), eq(disputes.tenantId, tenantId)))
    .limit(1);
  if (!row || row.dossierTenantId !== tenantId) return undefined;
  return row.dispute;
}

/** Preuves proposées : le brouillon enregistré, sinon le préremplissage à partir du Dossier. */
export async function disputeEvidenceFor(tenantId: string, d: DisputeRow): Promise<Evidence> {
  const saved = cleanEvidence((d.evidence ?? {}) as Record<string, unknown>);
  if (Object.keys(saved).length > 0) return saved;
  const [dossier] = await db
    .select()
    .from(dossiers)
    .where(and(eq(dossiers.id, d.dossierId), eq(dossiers.tenantId, tenantId)));
  if (!dossier) return {};
  const [tenant] = await db.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, tenantId));
  const [roomRows, [payment], refundRows] = await Promise.all([
    db
      .select({ name: rooms.name, total: bookings.totalPrice, status: bookings.status, createdAt: bookings.createdAt })
      .from(bookings)
      .innerJoin(rooms, eq(rooms.id, bookings.roomId))
      .where(and(eq(bookings.dossierId, d.dossierId), eq(bookings.tenantId, tenantId)))
      .orderBy(asc(bookings.createdAt), asc(bookings.id)),
    db
      .select({ amount: payments.amount, createdAt: payments.createdAt })
      .from(payments)
      .where(and(eq(payments.id, d.paymentId), eq(payments.tenantId, tenantId))),
    db
      .select({ amount: refunds.amount, createdAt: refunds.createdAt, status: refunds.status })
      .from(refunds)
      .where(and(eq(refunds.dossierId, d.dossierId), eq(refunds.tenantId, tenantId)))
      .orderBy(asc(refunds.createdAt)),
  ]);
  return defaultEvidence({
    hotelName: tenant?.name ?? "l'établissement",
    guestName: dossier.guestName,
    guestEmail: dossier.guestEmail,
    checkIn: dossier.checkIn,
    checkOut: dossier.checkOut,
    bookedAt: dossier.createdAt ?? roomRows[0]?.createdAt ?? null,
    rooms: roomRows.map((r) => ({ name: r.name, total: parseFloat(r.total), cancelled: r.status === "cancelled" })),
    paidAmount: payment ? parseFloat(payment.amount) : parseFloat(d.amount),
    paidAt: payment?.createdAt ?? null,
    confirmed: roomRows.some((r) => r.status === "confirmed" || r.status === "completed"),
    termsAcceptedAt: dossier.termsAcceptedAt,
    cancellationText: dossier.acceptedCancellationText,
    cgvText: dossier.acceptedCgvText,
    refunds: refundRows.map((r) => ({ amount: parseFloat(r.amount), at: r.createdAt, status: r.status })),
  });
}

/** Client Stripe et compte du tenant (démo : test, plateforme). */
async function stripeFor(tenantId: string) {
  const demo = await isDemoTenant(tenantId);
  const [tenant] = await db.select({ stripeAccountId: tenants.stripeAccountId }).from(tenants).where(eq(tenants.id, tenantId));
  if (!demo && !tenant?.stripeAccountId) {
    throw new DisputeActionError("Votre compte Stripe n'est plus connecté : reconnectez-le dans Paramètres.");
  }
  return {
    stripe: getStripe({ test: demo }),
    options: demo ? undefined : ({ stripeAccount: tenant!.stripeAccountId! } as Stripe.RequestOptions),
  };
}

function stripeDisputeError(e: unknown): DisputeActionError {
  const err = e as { type?: string; message?: string };
  console.error("Litige Stripe :", e);
  if (err?.type === "StripeConnectionError" || err?.type === "StripeAPIError" || !err?.type) {
    return new DisputeActionError("Stripe est injoignable pour le moment : rien n'a été envoyé. Réessayez dans un instant.");
  }
  return new DisputeActionError(`Stripe a refusé${err.message ? ` (« ${err.message} »)` : ""} : rien n'a été envoyé.`);
}

/** Litige du tenant verrouillé dans la transaction ; refus s'il est introuvable ou plus modifiable. */
async function lockForResponse(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], tenantId: string, disputeId: string) {
  if (!isUuid(disputeId)) throw new DisputeActionError("Litige introuvable.");
  const [d] = await tx
    .select()
    .from(disputes)
    .where(and(eq(disputes.id, disputeId), eq(disputes.tenantId, tenantId)))
    .for("update");
  if (!d) throw new DisputeActionError("Litige introuvable.");
  if (d.submittedAt) throw new DisputeActionError("La réponse a déjà été envoyée à la banque : elle ne se modifie plus.");
  if (disputeIsFinal(d.status)) throw new DisputeActionError("Ce litige est clos.");
  if (!canRespond(d)) throw new DisputeActionError("La date limite de réponse est dépassée : le litige ne se modifie plus.");
  return d;
}

/**
 * Enregistre les preuves chez Stripe (`disputes.update`) puis dans l'app. `submit` : envoi
 * définitif à la banque (un second envoi est refusé, sous verrou). Stripe en erreur : rien ne change.
 */
export async function saveDisputeEvidence(
  tenantId: string,
  disputeId: string,
  input: Record<string, unknown>,
  submit: boolean,
): Promise<{ status: string; submitted: boolean }> {
  const evidence = cleanEvidence(input);
  return db.transaction(async (tx) => {
    const d = await lockForResponse(tx, tenantId, disputeId);
    const { stripe, options } = await stripeFor(tenantId);
    // Tous les champs : un champ vidé par l'hôte est vidé chez Stripe aussi.
    const params = Object.fromEntries(EVIDENCE_FIELDS.map(({ key }) => [key, evidence[key] ?? ""]));
    let updated: Stripe.Dispute;
    try {
      updated = await stripe.disputes.update(d.stripeDisputeId, { evidence: params, submit }, options);
    } catch (e) {
      throw stripeDisputeError(e);
    }
    const status = nextDisputeStatus(d.status, updated.status ?? d.status);
    await tx
      .update(disputes)
      .set({ evidence, status, submittedAt: submit ? new Date() : null, updatedAt: new Date() })
      .where(eq(disputes.id, d.id));
    return { status, submitted: submit };
  });
}

/** Accepter le litige (`disputes.close`) : l'argent reste à la banque du voyageur, compté comme remboursé. */
export async function acceptDispute(tenantId: string, disputeId: string): Promise<{ status: string }> {
  return db.transaction(async (tx) => {
    const d = await lockForResponse(tx, tenantId, disputeId);
    const { stripe, options } = await stripeFor(tenantId);
    let closed: Stripe.Dispute;
    try {
      closed = await stripe.disputes.close(d.stripeDisputeId, {}, options);
    } catch (e) {
      throw stripeDisputeError(e);
    }
    const status = nextDisputeStatus(d.status, closed.status ?? "lost");
    await tx
      .update(disputes)
      .set({ status, closedAt: disputeIsFinal(status) ? new Date() : null, updatedAt: new Date() })
      .where(eq(disputes.id, d.id));
    return { status };
  });
}

/** Dernier litige du Dossier (la page « Répondre » porte sur celui-ci). */
export async function latestDossierDispute(tenantId: string, dossierId: string) {
  if (!isUuid(dossierId)) return undefined;
  const [d] = await db
    .select()
    .from(disputes)
    .innerJoin(dossiers, eq(dossiers.id, disputes.dossierId))
    .where(and(eq(disputes.dossierId, dossierId), eq(disputes.tenantId, tenantId), eq(dossiers.tenantId, tenantId)))
    .orderBy(desc(disputes.createdAt), desc(disputes.id))
    .limit(1);
  return d?.disputes;
}
