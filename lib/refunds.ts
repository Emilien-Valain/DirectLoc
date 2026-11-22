import type Stripe from "stripe";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookings, disputes, refunds } from "@/db/schema";
import { disputeIsOpen } from "@/lib/dispute-evidence";
import { sendRefundNotice } from "@/lib/email";
import { loadEmailContext } from "@/lib/queries/bookings";
import { cents } from "@/lib/refund-amounts";

/**
 * Remboursements d'un paiement en ligne (PRD « Remboursements et litiges », issue 02).
 * Créés depuis l'admin par `refundDossierPayment` (`lib/dossier-admin.ts`) ; la synchro par
 * webhook (`charge.refunded`, `refund.updated`, issue 03) retrouve une ligne par son id Stripe
 * (`findRefundByStripeId`) ou, pour un remboursement fait dans le tableau de bord Stripe, rattache
 * le payment_intent au paiement (`payments.stripe_payment_id`) puis au Dossier.
 */

export type RefundStatus = (typeof refunds.$inferSelect)["status"];

/** Statut Stripe d'un Refund → le nôtre. `requires_action` reste « en cours », `canceled` = échoué. */
export function refundStatusFromStripe(status: Stripe.Refund["status"]): RefundStatus {
  if (status === "succeeded") return "succeeded";
  if (status === "failed" || status === "canceled") return "failed";
  return "pending";
}

/**
 * Litige ouvert sur le paiement du Dossier : on ne rembourse pas un paiement contesté
 * (la banque a déjà repris l'argent ; rembourser = payer deux fois). Table `disputes` (issue 04).
 */
export async function hasOpenDispute(tenantId: string, dossierId: string): Promise<boolean> {
  const rows = await db
    .select({ status: disputes.status })
    .from(disputes)
    .where(and(eq(disputes.dossierId, dossierId), eq(disputes.tenantId, tenantId)));
  return rows.some((r) => disputeIsOpen(r.status));
}

/** Remboursements du Dossier (tous statuts), du plus ancien au plus récent. */
export async function getDossierRefunds(tenantId: string, dossierId: string) {
  return db
    .select()
    .from(refunds)
    .where(and(eq(refunds.dossierId, dossierId), eq(refunds.tenantId, tenantId)))
    .orderBy(asc(refunds.createdAt), asc(refunds.id));
}

/** Total remboursé ou en cours (les échecs ne comptent pas : rien n'est parti), en euros. */
export function refundedTotal(rows: { amount: string; status: RefundStatus }[]): number {
  return rows.filter((r) => r.status !== "failed").reduce((n, r) => n + cents(r.amount), 0) / 100;
}

/** Pour l'issue 03 (webhook) : la ligne d'un Refund Stripe, avec son tenant et son Dossier. */
export async function findRefundByStripeId(stripeRefundId: string) {
  const [row] = await db.select().from(refunds).where(eq(refunds.stripeRefundId, stripeRefundId)).limit(1);
  return row;
}

/**
 * Email au voyageur après un remboursement (« Remboursement de X € pour votre réservation »).
 * Best-effort : `false` si l'email n'a pas pu partir. Jamais depuis la démo (`sendEmail`).
 */
export async function notifyGuestRefund(tenantId: string, dossierId: string, amount: number): Promise<boolean> {
  try {
    const [first] = await db
      .select({ id: bookings.id })
      .from(bookings)
      .where(and(eq(bookings.dossierId, dossierId), eq(bookings.tenantId, tenantId)))
      .orderBy(asc(bookings.createdAt), asc(bookings.id))
      .limit(1);
    const ctx = first ? await loadEmailContext(first.id, tenantId) : null;
    if (!ctx) return false;
    const { guestName, guestEmail, hotelName, config, checkIn, checkOut } = ctx.emailData;
    await sendRefundNotice({ tenantId, guestName, guestEmail, hotelName, config, checkIn, checkOut, amount });
    return true;
  } catch (e) {
    console.error("Erreur envoi email remboursement:", e);
    return false;
  }
}
