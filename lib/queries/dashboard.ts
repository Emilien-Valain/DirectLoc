import { and, eq, gte, lt, lte, or, inArray, count, sum, asc } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookings, icalSources, rooms } from "@/db/schema";
import {
  todayStart,
  tomorrowStart,
  startOfMonth,
  endOfMonth,
} from "@/lib/date-windows";

// Bornes de dates (jour/semaine/mois) — toute l'arithmétique est en UTC pour
// rester alignée sur le stockage UTC-minuit des dates domaine (ADR-0005) et
// donc indépendante du `TZ` serveur. Voir `lib/date-windows.ts`.

// ─── Aujourd'hui ────────────────────────────────────────────────────────────

// Tous les séjours non annulés : un séjour « en attente » arrive et part comme les autres.
const LIVE = ["pending", "confirmed", "completed"] as const;

export async function getTodayMovements(tenantId: string) {
  const today = todayStart();
  const tomorrow = tomorrowStart();
  const withRoom = { room: { columns: { name: true } } } as const;

  const [arrivals, departures, staying] = await Promise.all([
    db.query.bookings.findMany({
      where: and(
        eq(bookings.tenantId, tenantId),
        gte(bookings.checkIn, today),
        lt(bookings.checkIn, tomorrow),
        inArray(bookings.status, [...LIVE]),
      ),
      with: withRoom,
      orderBy: [asc(bookings.guestName)],
    }),
    db.query.bookings.findMany({
      where: and(
        eq(bookings.tenantId, tenantId),
        gte(bookings.checkOut, today),
        lt(bookings.checkOut, tomorrow),
        inArray(bookings.status, [...LIVE]),
      ),
      with: withRoom,
      orderBy: [asc(bookings.guestName)],
    }),
    // Déjà là et encore là ce soir : avec les arrivées du jour, « qui dort ici ce soir ».
    db.query.bookings.findMany({
      where: and(
        eq(bookings.tenantId, tenantId),
        lt(bookings.checkIn, today),
        gte(bookings.checkOut, tomorrow),
        inArray(bookings.status, ["pending", "confirmed"]),
      ),
      with: withRoom,
      orderBy: [asc(bookings.checkOut), asc(bookings.guestName)],
    }),
  ]);

  return { arrivals, departures, staying };
}

// ─── 7 prochains jours (à partir de demain : aujourd'hui a son bloc) ─────────

export const WEEK_DAYS = 7;

/** Arrivées et départs de demain à J+7, pour un planning jour par jour. */
export async function getWeekMovements(tenantId: string) {
  const from = tomorrowStart();
  const to = new Date(from);
  to.setUTCDate(to.getUTCDate() + WEEK_DAYS);
  const inWeek = (col: typeof bookings.checkIn | typeof bookings.checkOut) => and(gte(col, from), lt(col, to));
  return db.query.bookings.findMany({
    where: and(
      eq(bookings.tenantId, tenantId),
      inArray(bookings.status, [...LIVE]),
      or(inWeek(bookings.checkIn), inWeek(bookings.checkOut)),
    ),
    with: { room: { columns: { name: true } } },
    orderBy: [asc(bookings.checkIn), asc(bookings.guestName)],
  });
}

// ─── À traiter : séjours non confirmés qui arrivent bientôt (ou sont déjà là) ─

/** En attente avec arrivée d'ici après-demain, y compris passée (webhook manqué, oubli). */
export async function getPendingSoon(tenantId: string) {
  const limit = tomorrowStart();
  limit.setUTCDate(limit.getUTCDate() + 2);
  return db.query.bookings.findMany({
    where: and(
      eq(bookings.tenantId, tenantId),
      eq(bookings.status, "pending"),
      lt(bookings.checkIn, limit),
    ),
    with: { room: { columns: { name: true } } },
    orderBy: [asc(bookings.checkIn)],
  });
}

// ─── Répartition par canal ──────────────────────────────────────────────────

export async function getBookingsByChannel(tenantId: string) {
  const monthStart = startOfMonth();
  const monthEnd = endOfMonth();

  const rows = await db
    .select({
      source: bookings.source,
      count: count(),
    })
    .from(bookings)
    .where(
      and(
        eq(bookings.tenantId, tenantId),
        gte(bookings.createdAt, monthStart),
        lte(bookings.createdAt, monthEnd),
        or(
          eq(bookings.status, "pending"),
          eq(bookings.status, "confirmed"),
          eq(bookings.status, "completed"),
        ),
      ),
    )
    .groupBy(bookings.source);

  return rows;
}

// ─── Taux d'occupation ──────────────────────────────────────────────────────

export async function getOccupancyRate(tenantId: string) {
  const today = todayStart();
  const tomorrow = tomorrowStart();

  // Nombre total de chambres actives
  const [totalResult] = await db
    .select({ total: count() })
    .from(rooms)
    .where(and(eq(rooms.tenantId, tenantId), eq(rooms.active, true)));

  const totalRooms = totalResult?.total ?? 0;

  if (totalRooms === 0) return { occupied: 0, total: 0, rate: 0 };

  // Chambres occupées aujourd'hui (booking confirmed/pending dont checkIn <= today < checkOut)
  const [occupiedResult] = await db
    .select({ occupied: count() })
    .from(bookings)
    .where(
      and(
        eq(bookings.tenantId, tenantId),
        lte(bookings.checkIn, today),
        gte(bookings.checkOut, tomorrow),
        or(eq(bookings.status, "confirmed"), eq(bookings.status, "pending")),
      ),
    );

  const occupied = occupiedResult?.occupied ?? 0;

  return {
    occupied,
    total: totalRooms,
    rate: Math.round((occupied / totalRooms) * 100),
  };
}

// ─── Chiffre d'affaires ─────────────────────────────────────────────────────

/** Montant des réservations confirmées ou terminées créées ce mois-ci (pas un encaissement). */
export async function getMonthRevenue(tenantId: string) {
  const [result] = await db
    .select({ revenue: sum(bookings.totalPrice) })
    .from(bookings)
    .where(
      and(
        eq(bookings.tenantId, tenantId),
        gte(bookings.createdAt, startOfMonth()),
        lte(bookings.createdAt, endOfMonth()),
        or(eq(bookings.status, "confirmed"), eq(bookings.status, "completed")),
      ),
    );

  return parseFloat(result?.revenue ?? "0");
}

// ─── Mise en route ──────────────────────────────────────────────────────────

/** Ce qu'un nouvel hôte a déjà fait : une chambre, un calendrier synchronisé, une réservation. */
export async function getSetupProgress(tenantId: string) {
  const [[r], [i], [b]] = await Promise.all([
    db.select({ n: count() }).from(rooms).where(and(eq(rooms.tenantId, tenantId), eq(rooms.active, true))),
    db.select({ n: count() }).from(icalSources).where(and(eq(icalSources.tenantId, tenantId), eq(icalSources.active, true))),
    db.select({ n: count() }).from(bookings).where(eq(bookings.tenantId, tenantId)),
  ]);
  const progress = { rooms: r.n > 0, ical: i.n > 0, bookings: b.n > 0 };
  // Le site tourne dès qu'il y a une chambre et des dates réelles (import iCal ou réservation).
  return { ...progress, done: progress.rooms && (progress.ical || progress.bookings) };
}

// ─── Tout en un ─────────────────────────────────────────────────────────────

export async function getDashboardData(tenantId: string) {
  const [today, week, pendingSoon, channels, occupancy, monthRevenue, setup] = await Promise.all([
    getTodayMovements(tenantId),
    getWeekMovements(tenantId),
    getPendingSoon(tenantId),
    getBookingsByChannel(tenantId),
    getOccupancyRate(tenantId),
    getMonthRevenue(tenantId),
    getSetupProgress(tenantId),
  ]);

  return { today, week, pendingSoon, channels, occupancy, monthRevenue, setup };
}
