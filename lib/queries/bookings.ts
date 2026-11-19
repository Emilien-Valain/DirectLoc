import { asRoomInfo, roomInfoVariables } from "@/lib/room-info";
import { splitName } from "@/lib/guest-name";
import { and, asc, count, desc, eq, gte, ilike, inArray, lte, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookings, payments, rooms, tenants } from "@/db/schema";
import { isUuid } from "@/lib/validation";
import { openCheckoutDeadline } from "@/lib/checkout-window";
import type { TenantConfig } from "@/lib/tenant-context";
import { getBookingLines } from "@/lib/queries/extras";

export type BookingStatus = "pending" | "confirmed" | "cancelled" | "completed";

export type BookingView = "a-venir" | "anciennes";

export interface BookingFilters {
  /** À venir = en attente ou confirmée (rien à faire de plus) ; anciennes = terminées ou annulées. */
  view?: BookingView;
  status?: BookingStatus;
  roomId?: string;
  /** Nom, email ou téléphone (chiffres seuls, espaces ignorés). */
  q?: string;
  /** Page 1-indexée — anciennes uniquement, à venir reste court. */
  page?: number;
}

export const OLD_BOOKINGS_PAGE_SIZE = 50;

const VIEW_STATUSES: Record<BookingView, BookingStatus[]> = {
  "a-venir": ["pending", "confirmed"],
  anciennes: ["completed", "cancelled"],
};

/** La vue qui contient un statut : `?status=cancelled` ouvre directement « Anciennes ». */
export function viewOfStatus(status?: BookingStatus): BookingView | undefined {
  if (!status) return undefined;
  return VIEW_STATUSES.anciennes.includes(status) ? "anciennes" : "a-venir";
}

export async function getBookingsByTenant(tenantId: string, filters: BookingFilters = {}) {
  const view = filters.view ?? "a-venir";
  const conditions = [
    eq(bookings.tenantId, tenantId),
    filters.status && VIEW_STATUSES[view].includes(filters.status)
      ? eq(bookings.status, filters.status)
      : inArray(bookings.status, VIEW_STATUSES[view]),
  ];
  if (filters.roomId && isUuid(filters.roomId)) conditions.push(eq(bookings.roomId, filters.roomId));

  const q = filters.q?.trim().slice(0, 100);
  if (q) {
    // Recherche littérale : % et _ saisis par l'hôte ne sont pas des jokers.
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const digits = q.replace(/\D/g, "");
    conditions.push(
      or(
        ilike(bookings.guestName, like),
        ilike(bookings.guestEmail, like),
        // « 06 12 34 » trouve « 0612345678 » et inversement.
        digits.length >= 3
          ? sql`regexp_replace(coalesce(${bookings.guestPhone}, ''), '\\D', '', 'g') like ${`%${digits}%`}`
          : undefined,
      )!,
    );
  }

  const where = and(...conditions);
  const paged = view === "anciennes";
  const page = Math.max(1, Math.floor(filters.page ?? 1));
  const [rows, [{ total }]] = await Promise.all([
    db.query.bookings.findMany({
      where,
      with: { room: { columns: { name: true } } },
      // À venir : la prochaine arrivée d'abord ; anciennes : la plus récente d'abord.
      orderBy: paged ? [desc(bookings.checkIn)] : [asc(bookings.checkIn)],
      ...(paged ? { limit: OLD_BOOKINGS_PAGE_SIZE, offset: (page - 1) * OLD_BOOKINGS_PAGE_SIZE } : {}),
    }),
    db.select({ total: count() }).from(bookings).where(where),
  ]);
  return { rows, total, page, pages: paged ? Math.max(1, Math.ceil(total / OLD_BOOKINGS_PAGE_SIZE)) : 1 };
}

export async function getBookingByIdAndTenant(id: string, tenantId: string) {
  // Un id mal formé n'existe pas : 404 côté page, pas d'erreur Postgres (500).
  if (!isUuid(id)) return undefined;
  return db.query.bookings.findFirst({
    where: and(eq(bookings.id, id), eq(bookings.tenantId, tenantId)),
    with: { room: { columns: { name: true, slug: true } } },
  });
}

/** Dernier paiement en ligne d'une réservation (aucun pour une saisie manuelle). */
export async function getLatestPayment(bookingId: string, tenantId: string) {
  // Même garde que getBookingByIdAndTenant : un id mal formé ferait échouer Postgres (500 au lieu de 404).
  if (!isUuid(bookingId)) return undefined;
  const [payment] = await db
    .select({
      status: payments.status,
      amount: payments.amount,
      stripePaymentId: payments.stripePaymentId,
      createdAt: payments.createdAt,
    })
    .from(payments)
    .where(and(eq(payments.bookingId, bookingId), eq(payments.tenantId, tenantId)))
    .orderBy(desc(payments.createdAt))
    .limit(1);
  return payment;
}

/**
 * Réservation que l'hôte peut encore modifier : en attente ou confirmée, et pas
 * en plein paiement en ligne (le prix ne doit pas bouger pendant le Checkout).
 */
export async function loadEditableBooking(id: string, tenantId: string) {
  const [booking, payment] = await Promise.all([
    getBookingByIdAndTenant(id, tenantId),
    getLatestPayment(id, tenantId),
  ]);
  if (!booking || (booking.status !== "pending" && booking.status !== "confirmed")) return null;
  if (openCheckoutDeadline(payment)) return null;
  return { booking, payment };
}

/**
 * Passe en `completed` les séjours confirmés dont le jour de départ est passé
 * (cf. CONTEXT.md > Booking status) : l'hôte n'a jamais à le faire à la main.
 * Sans `tenantId` : tous les tenants (cron). Idempotent.
 */
export async function completeFinishedStays(tenantId?: string) {
  const conditions = [
    eq(bookings.status, "confirmed"),
    sql`${bookings.checkOut} < CURRENT_DATE`,
  ];
  if (tenantId) conditions.push(eq(bookings.tenantId, tenantId));
  const done = await db
    .update(bookings)
    .set({ status: "completed", updatedAt: new Date() })
    .where(and(...conditions))
    .returning({ id: bookings.id });
  return done.length;
}

/**
 * Filet de sécurité (cron) : un booking public `pending` sans aucune ligne de
 * paiement, vieux de plus d'une heure, n'a jamais atteint Stripe (crash entre
 * l'insertion et la session) — aucun webhook `expired` ne viendra le libérer.
 * Ceux qui ont une session sont laissés au webhook : Stripe les annule ou les confirme.
 */
export async function cancelOrphanPending() {
  const done = await db
    .update(bookings)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(
      and(
        eq(bookings.status, "pending"),
        eq(bookings.source, "direct"),
        sql`${bookings.createdAt} < now() - interval '1 hour'`,
        sql`not exists (select 1 from ${payments} where ${payments.bookingId} = ${bookings.id})`,
      ),
    )
    .returning({ id: bookings.id });
  return done.length;
}

/** Réservations non annulées sur une plage, pour le calendrier (les terminées restent visibles dans le passé). */
export async function getActiveBookingsForCalendar(
  tenantId: string,
  from: Date,
  to: Date,
) {
  return db.query.bookings.findMany({
    where: and(
      eq(bookings.tenantId, tenantId),
      inArray(bookings.status, ["pending", "confirmed", "completed"]),
      lte(bookings.checkIn, to),
      gte(bookings.checkOut, from),
    ),
    columns: {
      id: true,
      roomId: true,
      checkIn: true,
      checkOut: true,
      status: true,
      guestName: true,
    },
  });
}

/** Booking + tout ce qu'un email client/hôte affiche (chambre, hôtel, config). `null` si introuvable. */
export async function loadEmailContext(bookingId: string, tenantId: string) {
  const [booking] = await db
    .select()
    .from(bookings)
    .where(and(eq(bookings.id, bookingId), eq(bookings.tenantId, tenantId)))
    .limit(1);
  if (!booking) return null;

  const [room] = await db
    .select({ name: rooms.name, capacity: rooms.capacity, beds: rooms.beds, emailMessage: rooms.emailMessage, info: rooms.info })
    .from(rooms)
    .where(eq(rooms.id, booking.roomId))
    .limit(1);
  // Infos définies sur d'autres chambres : vides ici plutôt qu'un « {code_portail} » brut dans l'email.
  const otherInfoKeys = (
    await db.select({ info: rooms.info }).from(rooms).where(eq(rooms.tenantId, tenantId))
  ).flatMap((r) => asRoomInfo(r.info).map((i) => i.key));

  const [tenant] = await db
    .select({ name: tenants.name, config: tenants.config })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);

  const extraLines = await getBookingLines(booking.id);

  const config = (tenant?.config ?? {}) as TenantConfig;
  const checkIn = new Date(booking.checkIn);
  const checkOut = new Date(booking.checkOut);
  const nights = Math.round(
    (checkOut.getTime() - checkIn.getTime()) / (1000 * 60 * 60 * 24),
  );

  return {
    booking,
    emailData: {
      guestName: booking.guestName,
      guestFirstName: booking.guestLastName ? booking.guestFirstName : splitName(booking.guestName).first,
      guestEmail: booking.guestEmail,
      roomName: room?.name ?? "Chambre",
      guestCount: booking.guestCount,
      roomCapacity: room?.capacity,
      roomBeds: room?.beds ?? null,
      roomMessage: room?.emailMessage ?? null,
      roomInfo: roomInfoVariables(asRoomInfo(room?.info), otherInfoKeys),
      checkIn,
      checkOut,
      nights,
      totalPrice: parseFloat(booking.totalPrice).toFixed(2),
      // Taxe : sans détail « q × prix » (prix moyen arrondi en mode %).
      extras: extraLines.filter((l) => !l.exempt).map((l) => ({ label: l.label, quantity: l.kind === "tax" ? 1 : l.quantity, unitPrice: l.unitPrice, total: l.total })),
      hotelName: tenant?.name ?? "Hôtel",
      config,
      tenantId,
    },
  };
}
