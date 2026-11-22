import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookings, dossiers, payments } from "@/db/schema";
import { isUuid } from "@/lib/validation";
import { grandTotal } from "@/lib/extras";

/**
 * Nombre de chambres (réservations, annulées comprises) de chaque Dossier du tenant.
 * Sert la liste et le calendrier : un Dossier de ≥ 2 chambres reste un groupe même
 * si l'une a été annulée depuis (paiement commun, fiche commune).
 */
export async function dossierSizes(tenantId: string, dossierIds: string[]): Promise<Map<string, number>> {
  const ids = [...new Set(dossierIds)];
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ dossierId: bookings.dossierId, n: count() })
    .from(bookings)
    .where(and(eq(bookings.tenantId, tenantId), inArray(bookings.dossierId, ids)))
    .groupBy(bookings.dossierId);
  return new Map(rows.map((r) => [r.dossierId, Number(r.n)]));
}

/** Dossier de la réservation (id + nombre de chambres) ; `undefined` si introuvable pour ce tenant. */
export async function getBookingDossier(bookingId: string, tenantId: string) {
  if (!isUuid(bookingId)) return undefined;
  const [row] = await db
    .select({ dossierId: bookings.dossierId })
    .from(bookings)
    .where(and(eq(bookings.id, bookingId), eq(bookings.tenantId, tenantId)));
  if (!row) return undefined;
  const sizes = await dossierSizes(tenantId, [row.dossierId]);
  return { id: row.dossierId, size: sizes.get(row.dossierId) ?? 1 };
}

/**
 * Fiche Dossier : voyageur, dates, chambres, dernier paiement en ligne.
 * `undefined` si l'id est mal formé, inconnu, ou d'un autre tenant (→ 404, jamais 500).
 */
export async function getDossierForAdmin(id: string, tenantId: string) {
  if (!isUuid(id)) return undefined;
  const dossier = await db.query.dossiers.findFirst({
    where: and(eq(dossiers.id, id), eq(dossiers.tenantId, tenantId)),
  });
  if (!dossier) return undefined;
  const [rooms, [payment]] = await Promise.all([
    db.query.bookings.findMany({
      where: and(eq(bookings.dossierId, id), eq(bookings.tenantId, tenantId)),
      with: { room: { columns: { name: true } } },
      orderBy: [asc(bookings.createdAt), asc(bookings.id)],
    }),
    db
      .select({
        id: payments.id,
        status: payments.status,
        amount: payments.amount,
        stripePaymentId: payments.stripePaymentId,
        createdAt: payments.createdAt,
      })
      .from(payments)
      .where(and(eq(payments.dossierId, id), eq(payments.tenantId, tenantId)))
      .orderBy(desc(payments.createdAt))
      .limit(1),
  ]);
  return { dossier, bookings: rooms, payment };
}

type MoneyBooking = { status: string; totalPrice: string; paidAt: Date | null };

/**
 * L'argent d'un Dossier, toutes chambres confondues (le paiement en ligne est commun) :
 * - `due` : total des chambres non annulées (ce que le séjour coûte) ;
 * - `paidOnline` : paiement Stripe abouti (total du Dossier au moment du paiement) ;
 * - `refunded` : remboursé ou en cours de remboursement (les échecs ne comptent pas) ;
 * - `net` : encaissé net = payé en ligne − remboursé ;
 * - `refundable` : ce qu'on peut encore rembourser (= `net`, plafond côté serveur) ;
 * - `balance` : reste à payer sur place = max(0, dû − payé en ligne), 0 si réglé hors ligne : un
 *   remboursement ne crée jamais de reste à payer (geste commercial, chambre annulée rendue) ;
 * - `refund` : trop-perçu = max(0, net − dû) (chambre annulée après paiement, prix baissé) ;
 * - `settled` : toutes les chambres non annulées sont marquées réglées hors ligne.
 */
export function dossierMoney(rooms: MoneyBooking[], payment?: { status: string; amount: string }, refunded = 0) {
  const c = (n: number) => Math.round(n * 100);
  const active = rooms.filter((b) => b.status !== "cancelled");
  const due = grandTotal(0, active.map((b) => ({ total: parseFloat(b.totalPrice) })));
  const paidOnline = payment?.status === "paid" ? parseFloat(payment.amount) : 0;
  const net = paidOnline > 0 ? Math.max(0, c(paidOnline) - c(refunded)) / 100 : 0;
  const settled = active.length > 0 && active.every((b) => b.paidAt);
  // Sans paiement en ligne, rien n'est « reste » : tout se règle avec le client (balanceDue).
  const balance = active.length === 0 || paidOnline <= 0 || settled ? 0 : Math.max(0, c(due) - c(paidOnline)) / 100;
  const refund = paidOnline > 0 ? Math.max(0, c(net) - c(due)) / 100 : 0;
  return { due, paidOnline, refunded: paidOnline > 0 ? refunded : 0, net, refundable: net, balance, refund, settled, activeCount: active.length };
}
