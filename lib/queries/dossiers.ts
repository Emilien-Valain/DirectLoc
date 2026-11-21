import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookings, dossiers, payments } from "@/db/schema";
import { isUuid } from "@/lib/validation";
import { balanceDue, grandTotal } from "@/lib/extras";

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
 * - `balance` : reste à payer sur place (options ajoutées après le paiement), 0 si réglé ;
 * - `refund` : trop-perçu à rembourser à la main dans Stripe (chambre annulée après
 *   paiement, ou prix baissé) — DirectLoc ne rembourse jamais seul.
 * - `settled` : toutes les chambres non annulées sont marquées réglées hors ligne.
 */
export function dossierMoney(rooms: MoneyBooking[], payment?: { status: string; amount: string }) {
  const active = rooms.filter((b) => b.status !== "cancelled");
  const due = grandTotal(0, active.map((b) => ({ total: parseFloat(b.totalPrice) })));
  const paidOnline = payment?.status === "paid" ? parseFloat(payment.amount) : 0;
  const settled = active.length > 0 && active.every((b) => b.paidAt);
  const balance = active.length === 0 ? 0 : balanceDue(due, paidOnline, settled ? new Date() : null);
  const refund = paidOnline > 0 ? Math.max(0, Math.round((paidOnline - due) * 100) / 100) : 0;
  return { due, paidOnline, balance, refund, settled, activeCount: active.length };
}
