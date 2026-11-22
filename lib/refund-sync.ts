import type Stripe from "stripe";
import { and, asc, eq, ne } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookings, dossiers, payments, refunds, tenants, userTenants, users } from "@/db/schema";
import { isDemoTenant } from "@/lib/demo";
import { sendRefundFailedAlert } from "@/lib/email";
import { loadEmailContext } from "@/lib/queries/bookings";
import { notifyGuestRefund, refundStatusFromStripe, type RefundStatus } from "@/lib/refunds";
import { getStripe, stripeModeAllowed } from "@/lib/stripe";

/**
 * Synchro des remboursements par webhook (issue 03) : `charge.refunded`, `refund.created`,
 * `refund.updated`, `refund.failed`. Un remboursement créé dans l'app est retrouvé par son id
 * Stripe (mise à jour du statut, jamais de doublon) ; un remboursement fait dans le tableau de
 * bord Stripe devient une ligne `stripe_<re_id>` + un email au voyageur. Tout est idempotent :
 * les événements arrivent plusieurs fois et dans le désordre.
 */

export const REFUND_EVENT_TYPES = new Set(["charge.refunded", "refund.created", "refund.updated", "refund.failed"]);

/** Emails des admins du tenant (destinataires des notifications hôte). */
export async function tenantAdminEmails(tenantId: string): Promise<string[]> {
  const rows = await db
    .select({ email: users.email })
    .from(userTenants)
    .innerJoin(users, eq(users.id, userTenants.userId))
    .where(eq(userTenants.tenantId, tenantId));
  return rows.map((r) => r.email);
}

export const idOf = (v: string | { id: string } | null | undefined) => (typeof v === "string" ? v : (v?.id ?? null));

/**
 * Paiement visé par un événement Stripe (remboursement, litige), avec son tenant et son Dossier.
 * Le paiement est le nôtre (écrit par ce serveur) ; le compte de l'événement doit être celui du
 * tenant (démo : événement plateforme sans compte, en test uniquement). `null` sinon (journalisé).
 */
export async function resolveEventPayment(event: Stripe.Event, paymentIntent: string) {
  const [row] = await db
    .select({
      paymentId: payments.id,
      dossierId: payments.dossierId,
      tenantId: payments.tenantId,
      dossierTenantId: dossiers.tenantId,
      stripeAccountId: tenants.stripeAccountId,
    })
    .from(payments)
    .innerJoin(dossiers, eq(dossiers.id, payments.dossierId))
    .innerJoin(tenants, eq(tenants.id, payments.tenantId))
    .where(eq(payments.stripePaymentId, paymentIntent))
    .limit(1);
  if (!row || row.dossierTenantId !== row.tenantId) {
    console.error(`[stripe] Événement ${event.id} (compte ${event.account ?? "plateforme"}) ignoré : payment_intent ${paymentIntent} inconnu`);
    return null;
  }
  const demo = await isDemoTenant(row.tenantId);
  // Démo : compte plateforme, en test uniquement. Hôtel : le compte connecté de l'événement est le sien.
  const sameAccount = demo ? !event.account : !!event.account && event.account === row.stripeAccountId;
  if (!sameAccount || !stripeModeAllowed(event.livemode, demo)) {
    console.error(`[stripe] Événement ${event.id} (compte ${event.account ?? "plateforme"}, livemode=${event.livemode}) ignoré : paiement ${paymentIntent} d'un autre compte ou mode incompatible`);
    return null;
  }
  return { paymentId: row.paymentId, dossierId: row.dossierId, tenantId: row.tenantId };
}

/** Un Refund créé par l'app depuis moins de 2 min peut ne pas encore avoir sa ligne (course avec l'insert). */
const APP_INSERT_GRACE_S = 120;

export type RefundSyncResult = "ignored" | "retry" | "synced";

/** Un final ne repasse jamais « en cours » (événements dans le désordre) ; « effectué » peut échouer a posteriori. */
function nextStatus(current: RefundStatus, incoming: RefundStatus): RefundStatus {
  if (current === "pending") return incoming;
  if (incoming === "pending") return current;
  return incoming;
}

export async function handleRefundEvent(event: Stripe.Event): Promise<RefundSyncResult> {
  const object = event.data.object as unknown as Record<string, unknown>;
  let list: Stripe.Refund[] = [];
  let paymentIntent: string | null;

  if (event.type === "charge.refunded") {
    const charge = object as unknown as Stripe.Charge;
    paymentIntent = idOf(charge.payment_intent as string | null);
    // La liste des Refunds n'est plus incluse par défaut dans l'objet Charge : on la relit chez Stripe.
    list = (charge.refunds?.data as Stripe.Refund[] | undefined) ?? [];
    if (list.length === 0 && paymentIntent) {
      const demoLookup = !event.account;
      try {
        const res = await getStripe({ test: demoLookup }).refunds.list(
          { payment_intent: paymentIntent, limit: 100 },
          event.account ? { stripeAccount: event.account } : undefined,
        );
        list = res.data;
      } catch (e) {
        console.error(`[stripe] Événement ${event.id} : liste des remboursements illisible`, e);
        return "retry";
      }
    }
  } else {
    const refund = object as unknown as Stripe.Refund;
    paymentIntent = idOf(refund.payment_intent as string | null);
    list = [refund];
  }

  if (!paymentIntent) {
    console.error(`[stripe] Événement ${event.id} ignoré : pas de payment_intent`);
    return "ignored";
  }

  const row = await resolveEventPayment(event, paymentIntent);
  if (!row) return "ignored";

  let result: RefundSyncResult = "synced";
  for (const refund of list) {
    if (refund.currency && refund.currency !== "eur") continue;
    if (await syncOne(event, refund, row)) result = "retry";
  }
  return result;
}

/** `true` : à rejouer plus tard par Stripe (ligne de l'app pas encore écrite). */
async function syncOne(
  event: Stripe.Event,
  refund: Stripe.Refund,
  p: { paymentId: string; dossierId: string; tenantId: string },
): Promise<boolean> {
  const status = refundStatusFromStripe(refund.status);
  const failureReason = status === "failed" ? (refund.failure_reason ?? "failed") : null;
  const existing = await db.select().from(refunds).where(eq(refunds.stripeRefundId, refund.id)).limit(1);

  if (existing[0]) {
    const cur = existing[0];
    if (cur.tenantId !== p.tenantId || cur.dossierId !== p.dossierId) {
      console.error(`[stripe] Remboursement ${refund.id} ignoré : rattaché à un autre Dossier`);
      return false;
    }
    const next = nextStatus(cur.status, status);
    if (next === cur.status) return false;
    // Conditionnel : deux livraisons simultanées ne notifient qu'une fois.
    const updated = await db
      .update(refunds)
      .set({ status: next, failureReason: next === "failed" ? failureReason : null, updatedAt: new Date() })
      .where(and(eq(refunds.id, cur.id), ne(refunds.status, next)))
      .returning({ id: refunds.id });
    if (updated.length > 0 && next === "failed") await alertRefundFailed(p.tenantId, p.dossierId, cur.amount, failureReason);
    return false;
  }

  // Créé par l'app (metadata posée à la création) mais ligne pas encore là : Stripe rejouera.
  const appMade = refund.metadata?.dossierId === p.dossierId;
  if (appMade && Date.now() / 1000 - event.created < APP_INSERT_GRACE_S) return true;

  const amount = (refund.amount / 100).toFixed(2);
  const inserted = await db
    .insert(refunds)
    .values({
      tenantId: p.tenantId,
      dossierId: p.dossierId,
      paymentId: p.paymentId,
      amount,
      reason: appMade ? null : "Remboursé depuis Stripe",
      status,
      stripeRefundId: refund.id,
      idempotencyKey: `stripe_${refund.id}`,
      failureReason,
    })
    .onConflictDoNothing()
    .returning({ id: refunds.id });
  if (inserted.length === 0) return false; // une livraison concurrente l'a créé : elle notifie.

  if (status === "failed") await alertRefundFailed(p.tenantId, p.dossierId, amount, failureReason);
  else await notifyGuestRefund(p.tenantId, p.dossierId, refund.amount / 100);
  return false;
}

/** Email aux admins du tenant : un remboursement a échoué (le bandeau rouge de la fiche Dossier est permanent). */
async function alertRefundFailed(tenantId: string, dossierId: string, amount: string, reason: string | null) {
  try {
    const [first] = await db
      .select({ id: bookings.id })
      .from(bookings)
      .where(and(eq(bookings.dossierId, dossierId), eq(bookings.tenantId, tenantId)))
      .orderBy(asc(bookings.createdAt), asc(bookings.id))
      .limit(1);
    const ctx = first ? await loadEmailContext(first.id, tenantId) : null;
    if (!ctx) return;
    for (const adminEmail of await tenantAdminEmails(tenantId)) {
      const { guestName, guestEmail, hotelName, config, checkIn, checkOut } = ctx.emailData;
      await sendRefundFailedAlert({ tenantId, adminEmail, guestName, guestEmail, hotelName, config, checkIn, checkOut, amount, reason });
    }
  } catch (e) {
    console.error("Erreur envoi alerte remboursement échoué:", e);
  }
}
