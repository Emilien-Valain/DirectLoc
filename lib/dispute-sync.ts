import type Stripe from "stripe";
import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookings, disputes } from "@/db/schema";
import { sendDisputeAlert } from "@/lib/email";
import { loadEmailContext } from "@/lib/queries/bookings";
import { idOf, resolveEventPayment, tenantAdminEmails } from "@/lib/refund-sync";
import { disputeIsFinal, disputeIsOpen, disputeReasonFr, nextDisputeStatus } from "@/lib/dispute-evidence";

/**
 * Synchro des litiges par webhook (issue 04) : `charge.dispute.created|updated|closed`.
 * Rattachement comme les remboursements (`resolveEventPayment`) : payment_intent → notre paiement,
 * compte de l'événement = compte du tenant (démo : plateforme, test). Idempotent et insensible à
 * l'ordre : un statut ne recule jamais (`nextDisputeStatus`), l'alerte aux admins part une fois.
 */

export const DISPUTE_EVENT_TYPES = new Set(["charge.dispute.created", "charge.dispute.updated", "charge.dispute.closed"]);

export async function handleDisputeEvent(event: Stripe.Event): Promise<"ignored" | "synced"> {
  const dispute = event.data.object as Stripe.Dispute;
  const paymentIntent = idOf(dispute?.payment_intent as string | null);
  if (!dispute?.id || !paymentIntent || (dispute.currency && dispute.currency !== "eur")) {
    console.error(`[stripe] Événement ${event.id} ignoré : litige sans payment_intent ou hors euros`);
    return "ignored";
  }
  const p = await resolveEventPayment(event, paymentIntent);
  if (!p) return "ignored";

  const amount = ((dispute.amount ?? 0) / 100).toFixed(2);
  const dueBy = dispute.evidence_details?.due_by ? new Date(dispute.evidence_details.due_by * 1000) : null;
  const submittedByStripe = (dispute.evidence_details?.submission_count ?? 0) > 0;
  const incoming = dispute.status ?? "needs_response";

  const row = await db.transaction(async (tx) => {
    await tx
      .insert(disputes)
      .values({
        tenantId: p.tenantId,
        dossierId: p.dossierId,
        paymentId: p.paymentId,
        stripeDisputeId: dispute.id,
        amount,
        reason: dispute.reason ?? "general",
        status: incoming,
        evidenceDueBy: dueBy,
        submittedAt: submittedByStripe ? new Date() : null,
        closedAt: disputeIsFinal(incoming) ? new Date() : null,
      })
      .onConflictDoNothing();
    const [cur] = await tx.select().from(disputes).where(eq(disputes.stripeDisputeId, dispute.id)).for("update");
    if (!cur || cur.tenantId !== p.tenantId || cur.paymentId !== p.paymentId) {
      console.error(`[stripe] Litige ${dispute.id} ignoré : rattaché à un autre paiement`);
      return null;
    }
    const status = nextDisputeStatus(cur.status, incoming);
    const [updated] = await tx
      .update(disputes)
      .set({
        amount,
        reason: dispute.reason ?? cur.reason,
        status,
        evidenceDueBy: dueBy ?? cur.evidenceDueBy,
        // Réponse envoyée depuis le tableau de bord Stripe : lecture seule dans l'app aussi.
        submittedAt: cur.submittedAt ?? (submittedByStripe ? new Date() : null),
        closedAt: cur.closedAt ?? (disputeIsFinal(status) ? new Date() : null),
        updatedAt: new Date(),
      })
      .where(eq(disputes.id, cur.id))
      .returning();
    return updated;
  });
  if (!row) return "ignored";

  // Une seule alerte, réservée par un UPDATE conditionnel (deux livraisons simultanées : une seule passe).
  if (disputeIsOpen(row.status)) {
    const claimed = await db
      .update(disputes)
      .set({ alertedAt: new Date() })
      .where(and(eq(disputes.id, row.id), isNull(disputes.alertedAt)))
      .returning({ id: disputes.id });
    if (claimed.length > 0) await alertDispute(row.tenantId, row.dossierId, row.amount, row.reason, row.evidenceDueBy);
  }
  return "synced";
}

/** Email aux admins du tenant (jamais depuis la démo : `sendEmail`). Best-effort. */
async function alertDispute(tenantId: string, dossierId: string, amount: string, reason: string, dueBy: Date | null) {
  try {
    const [first] = await db
      .select({ id: bookings.id })
      .from(bookings)
      .where(and(eq(bookings.dossierId, dossierId), eq(bookings.tenantId, tenantId)))
      .orderBy(asc(bookings.createdAt), asc(bookings.id))
      .limit(1);
    const ctx = first ? await loadEmailContext(first.id, tenantId) : null;
    if (!ctx) return;
    const { guestName, guestEmail, hotelName, config, checkIn, checkOut } = ctx.emailData;
    for (const adminEmail of await tenantAdminEmails(tenantId)) {
      await sendDisputeAlert({
        tenantId,
        adminEmail,
        guestName,
        guestEmail,
        hotelName,
        config,
        checkIn,
        checkOut,
        amount,
        reason: disputeReasonFr(reason),
        dueBy,
        dossierId,
      });
    }
  } catch (e) {
    console.error("Erreur envoi alerte litige:", e);
  }
}
