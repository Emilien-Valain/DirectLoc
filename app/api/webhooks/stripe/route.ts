import { NextResponse } from "next/server";
import { captureServer } from "@/lib/analytics";
import type { NextRequest } from "next/server";
import Stripe from "stripe";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookings, dossiers, payments, rooms, users, userTenants } from "@/db/schema";
import { cancelPendingDossier, confirmDossier, getDossierBookingIds } from "@/lib/dossiers";
import { getStripe, stripeModeAllowed } from "@/lib/stripe";
import { isDemoTenant } from "@/lib/demo";
import {
  sendBookingConfirmation,
  sendAdminNotification,
  sendBookingCancellation,
  sendPaidAfterCancellationAlert,
} from "@/lib/email";
import { isUuid } from "@/lib/validation";
import { loadDossierEmailContext, loadEmailContext } from "@/lib/queries/bookings";

/** Emails des admins du tenant (destinataires des notifications hôte). */
async function tenantAdminEmails(tenantId: string): Promise<string[]> {
  const rows = await db
    .select({ email: users.email })
    .from(userTenants)
    .innerJoin(users, eq(users.id, userTenants.userId))
    .where(eq(userTenants.tenantId, tenantId));
  return rows.map((r) => r.email);
}

export async function POST(request: NextRequest) {
  const body = await request.text();
  const signature = request.headers.get("stripe-signature");

  if (!signature) {
    return NextResponse.json({ error: "Signature manquante" }, { status: 400 });
  }

  // Deux endpoints Stripe pointent ici, chacun avec son secret : le compte plateforme
  // et l'endpoint Connect (direct charges : les sessions vivent sur le compte du tenant).
  // + l'endpoint mode test du tenant démo quand la plateforme passe en live.
  let event: Stripe.Event | undefined;
  for (const secret of [
    process.env.STRIPE_WEBHOOK_SECRET,
    process.env.STRIPE_CONNECT_WEBHOOK_SECRET,
    process.env.STRIPE_TEST_WEBHOOK_SECRET,
  ]) {
    if (!secret) continue;
    try {
      event = getStripe().webhooks.constructEvent(body, signature, secret);
      break;
    } catch {}
  }
  if (!event) {
    return NextResponse.json({ error: "Signature invalide" }, { status: 400 });
  }

  // La session doit être l'une des nôtres, créée pour CE Dossier de CE tenant : seul
  // ce serveur écrit les payments, et Stripe choisit l'id de session. Un autre compte
  // connecté ne peut donc pas agir sur la résa d'un autre hôtel, et une session créée
  // avant une déconnexion/reconnexion Stripe reste reconnue (pas le compte actuel).
  if (!event.type.startsWith("checkout.session.")) {
    return NextResponse.json({ received: true });
  }
  const session = event.data.object as Stripe.Checkout.Session;
  const tenantId = session.metadata?.tenantId;
  const dossierId = tenantId ? await sessionDossier(session, tenantId) : null;
  if (!tenantId || !dossierId) {
    console.error(`[stripe] Événement ${event.id} (compte ${event.account ?? "plateforme"}) ignoré : session ${session.id} inconnue pour ce Dossier`);
    return NextResponse.json({ received: true });
  }
  if (!stripeModeAllowed(event.livemode, await isDemoTenant(tenantId))) {
    console.error(`[stripe] Événement ${event.id} (livemode=${event.livemode}) ignoré : mode incompatible avec le tenant ${tenantId}`);
    return NextResponse.json({ received: true });
  }

  switch (event.type) {
    case "checkout.session.completed": {
      // Transition légale + idempotence : ne confirmer QUE depuis `pending`, toutes
      // les chambres du Dossier d'un coup. Stripe livre chaque événement au moins
      // une fois (retries) ; une livraison dupliquée, ou un événement tardif sur un
      // Dossier déjà confirmé/annulé, n'affecte aucune ligne — on n'envoie alors pas
      // d'email en double et on ne « ressuscite » pas une réservation annulée.
      const confirmed = await confirmDossier(dossierId, tenantId);

      if (confirmed.length === 0) {
        await handlePaidAfterCancellation(session, dossierId, tenantId);
        break;
      }

      await db
        .update(payments)
        .set({
          status: "paid",
          stripePaymentId: session.payment_intent as string,
        })
        .where(eq(payments.stripeSessionId, session.id));
      captureServer("booking_paid", { surface: "tenant_site", tenant_id: tenantId }, session.metadata?.posthogDistinctId);
      // Une chambre annulée par l'hôte pendant le paiement : l'argent la couvre aussi.
      await alertPartialRefund(session, dossierId, tenantId, confirmed[0]);

      // Envoyer les emails (best-effort, ne pas bloquer le webhook) : un par Dossier,
      // pour les chambres qui viennent d'être confirmées.
      try {
        const ctx = await loadDossierEmailContext(confirmed, tenantId);
        if (ctx) {
          await sendBookingConfirmation({
            ...ctx.emailData,
            confirmationMessage: ctx.emailData.config.confirmationMessage,
          });

          for (const adminEmail of await tenantAdminEmails(tenantId)) {
            await sendAdminNotification({
              ...ctx.emailData,
              guestPhone: ctx.guestPhone,
              adminEmail,
            });
          }
        }
      } catch (emailError) {
        console.error("Erreur envoi email après paiement:", emailError);
      }

      break;
    }

    case "checkout.session.expired": {
      // Transition légale + idempotence : n'annuler QUE depuis `pending`.
      // Un Dossier déjà confirmé (paiement abouti) ne doit pas être annulé par un
      // événement `expired` tardif/dupliqué, et on n'envoie pas un second email
      // d'annulation sur une re-livraison.
      const cancelled = await cancelPendingDossier(dossierId, tenantId);

      if (cancelled.length === 0) break;

      await db
        .update(payments)
        .set({ status: "expired" })
        .where(eq(payments.stripeSessionId, session.id));

      try {
        const ctx = await loadDossierEmailContext(cancelled, tenantId);
        if (ctx) {
          const { rooms, ...stay } = ctx.emailData;
          await sendBookingCancellation({ ...stay, roomNames: rooms.map((r) => r.roomName), reason: "payment_expired" });
        }
      } catch (emailError) {
        console.error("Erreur envoi email annulation:", emailError);
      }

      break;
    }
  }

  return NextResponse.json({ received: true });
}

/**
 * Dossier de la session, si elle est bien la nôtre pour ce tenant : le payment
 * (écrit par ce serveur) porte l'id de session choisi par Stripe. La metadata doit
 * désigner ce Dossier (`dossierId`), ou l'une de ses réservations (`bookingId` :
 * sessions créées avant les Dossiers). `null` sinon, ou si la metadata est malformée.
 */
async function sessionDossier(session: Stripe.Checkout.Session, tenantId: string): Promise<string | null> {
  const { dossierId, bookingId } = session.metadata ?? {};
  if (!isUuid(tenantId)) return null;
  const [payment] = await db
    .select({ dossierId: payments.dossierId })
    .from(payments)
    .innerJoin(dossiers, eq(dossiers.id, payments.dossierId))
    .where(and(eq(payments.stripeSessionId, session.id), eq(payments.tenantId, tenantId), eq(dossiers.tenantId, tenantId)))
    .limit(1);
  if (!payment) return null;
  if (dossierId) return dossierId === payment.dossierId ? payment.dossierId : null;
  if (bookingId && isUuid(bookingId)) {
    const ids = await getDossierBookingIds(payment.dossierId, tenantId);
    return ids.includes(bookingId) ? payment.dossierId : null;
  }
  return null;
}

/**
 * Paiement abouti sur un Dossier annulé entre-temps (annulation admin pendant
 * que le client était sur Stripe Checkout). On ne ressuscite pas les réservations,
 * mais l'argent est bien encaissé : on marque le payment `paid` et on alerte
 * l'hôte pour qu'il rembourse. Pas de remboursement automatique (décision).
 * Idempotent : seul le passage `pending → paid` du payment déclenche l'alerte.
 */
async function handlePaidAfterCancellation(
  session: Stripe.Checkout.Session,
  dossierId: string,
  tenantId: string,
) {
  const rows = await db
    .select({ id: bookings.id, status: bookings.status })
    .from(bookings)
    .where(and(eq(bookings.dossierId, dossierId), eq(bookings.tenantId, tenantId)));
  if (rows.length === 0 || rows.some((b) => b.status !== "cancelled")) return;

  const stripePaymentId = session.payment_intent as string;
  const paid = await db
    .update(payments)
    .set({ status: "paid", stripePaymentId })
    .where(and(eq(payments.stripeSessionId, session.id), eq(payments.status, "pending")))
    .returning({ id: payments.id });
  if (paid.length === 0) return;

  console.error(
    `[stripe] Paiement reçu sur un Dossier annulé — dossier ${dossierId}, payment_intent ${stripePaymentId} : remboursement à faire`,
  );

  try {
    const [first] = await getDossierBookingIds(dossierId, tenantId);
    const ctx = first ? await loadEmailContext(first, tenantId) : null;
    if (!ctx) return;
    for (const adminEmail of await tenantAdminEmails(tenantId)) {
      await sendPaidAfterCancellationAlert({ ...ctx.emailData, adminEmail, stripePaymentId });
    }
  } catch (emailError) {
    console.error("Erreur envoi alerte paiement après annulation:", emailError);
  }
}

/**
 * Paiement abouti alors qu'une partie des chambres du Dossier avait été annulée par
 * l'hôte (les autres viennent d'être confirmées) : le client a payé ces chambres aussi.
 * Alerte « remboursement partiel à faire » aux admins ; jamais de remboursement auto.
 * Appelé seulement quand des chambres viennent d'être confirmées : une re-livraison
 * Stripe ne confirme plus rien, donc pas d'alerte en double.
 */
async function alertPartialRefund(
  session: Stripe.Checkout.Session,
  dossierId: string,
  tenantId: string,
  confirmedBookingId: string,
) {
  const cancelled = await db
    .select({ name: rooms.name, total: bookings.totalPrice })
    .from(bookings)
    .innerJoin(rooms, eq(rooms.id, bookings.roomId))
    .where(and(eq(bookings.dossierId, dossierId), eq(bookings.tenantId, tenantId), eq(bookings.status, "cancelled")));
  if (cancelled.length === 0) return;

  const stripePaymentId = session.payment_intent as string;
  console.error(
    `[stripe] Paiement reçu sur un Dossier en partie annulé — dossier ${dossierId}, payment_intent ${stripePaymentId} : remboursement partiel à faire`,
  );
  try {
    const ctx = await loadEmailContext(confirmedBookingId, tenantId);
    if (!ctx) return;
    const cancelledRooms = cancelled.map((r) => ({ name: r.name, total: parseFloat(r.total).toFixed(2) }));
    for (const adminEmail of await tenantAdminEmails(tenantId)) {
      await sendPaidAfterCancellationAlert({ ...ctx.emailData, adminEmail, stripePaymentId, cancelledRooms });
    }
  } catch (emailError) {
    console.error("Erreur envoi alerte remboursement partiel:", emailError);
  }
}
