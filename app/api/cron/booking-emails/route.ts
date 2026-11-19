import { NextRequest, NextResponse } from "next/server";
import { and, eq, isNull, sql, inArray, gt, lte } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookings } from "@/db/schema";
import { sendCheckInReminder, sendPostStayThankYou } from "@/lib/email";
import { cancelOrphanPending, completeFinishedStays, loadEmailContext } from "@/lib/queries/bookings";
import { MAX_REMINDER_DAYS, reminderDays, reminderDue } from "@/lib/email-template";
import { todayStart } from "@/lib/date-windows";

/**
 * GET /api/cron/booking-emails
 *
 * Envoie les emails automatiques :
 * - Rappel avant l'arrivée (bookings confirmed, reminderSentAt IS NULL) : J-2 par défaut,
 *   délai réglé par l'hôte (config.reminderDaysBefore, 0 = désactivé) — voir reminderDue
 * - Remerciement post-séjour (bookings confirmed/completed, checkOut = hier, thankYouSentAt IS NULL)
 * Et clôt les séjours terminés (confirmed → completed une fois le départ passé),
 * et libère les pending publics qui n'ont jamais atteint Stripe.
 *
 * Protégé par CRON_SECRET. Usage Coolify : tous les jours à 10h
 *   curl -s -H "Authorization: Bearer $CRON_SECRET" https://domaine/api/cron/booking-emails
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;

  if (!secret) {
    console.error("[booking-emails cron] CRON_SECRET non configuré");
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }

  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const results = { reminders: 0, thankYous: 0, completed: 0, orphansCancelled: 0, errors: 0 };

  try {
    results.completed = await completeFinishedStays();
  } catch (err) {
    console.error("[booking-emails] Erreur clôture des séjours:", err);
    results.errors++;
  }

  try {
    results.orphansCancelled = await cancelOrphanPending();
  } catch (err) {
    console.error("[booking-emails] Erreur libération des pending orphelins:", err);
    results.errors++;
  }

  // ── Rappels avant l'arrivée ─────────────────────────────────────────────
  try {
    // Candidats : arrivée dans 1 à MAX_REMINDER_DAYS jours ; le délai propre à
    // chaque établissement est appliqué ensuite (reminderDue).
    const today = todayStart(now);
    const horizon = new Date(today);
    horizon.setUTCDate(horizon.getUTCDate() + MAX_REMINDER_DAYS);

    const reminderBookings = await db
      .select({ id: bookings.id, tenantId: bookings.tenantId, checkIn: bookings.checkIn, createdAt: bookings.createdAt })
      .from(bookings)
      .where(
        and(
          eq(bookings.status, "confirmed"),
          isNull(bookings.reminderSentAt),
          gt(bookings.checkIn, today),
          lte(bookings.checkIn, horizon),
        ),
      );

    for (const booking of reminderBookings) {
      try {
        const ctx = await loadEmailContext(booking.id, booking.tenantId);
        if (!ctx) continue;
        const days = reminderDays(ctx.emailData.config);
        if (!reminderDue(booking, today, days)) continue;
        const daysUntil = Math.round((booking.checkIn.getTime() - today.getTime()) / 86_400_000);
        await sendCheckInReminder({ ...ctx.emailData, daysUntil });

        await db
          .update(bookings)
          .set({ reminderSentAt: new Date() })
          .where(eq(bookings.id, booking.id));

        results.reminders++;
      } catch (err) {
        console.error(`[booking-emails] Erreur rappel booking ${booking.id}:`, err);
        results.errors++;
      }
    }
  } catch (err) {
    console.error("[booking-emails] Erreur requête rappels:", err);
    results.errors++;
  }

  // ── Remerciements post-séjour ───────────────────────────────────────────
  try {
    // Trouver les bookings dont le checkOut était hier
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const targetDate = yesterday.toISOString().split("T")[0];

    const thankYouBookings = await db
      .select({ id: bookings.id, tenantId: bookings.tenantId })
      .from(bookings)
      .where(
        and(
          inArray(bookings.status, ["confirmed", "completed"]),
          isNull(bookings.thankYouSentAt),
          sql`DATE(${bookings.checkOut}) = ${targetDate}`,
        ),
      );

    for (const booking of thankYouBookings) {
      try {
        const ctx = await loadEmailContext(booking.id, booking.tenantId);
        if (!ctx) continue;
        await sendPostStayThankYou(ctx.emailData);

        await db
          .update(bookings)
          .set({ thankYouSentAt: new Date() })
          .where(eq(bookings.id, booking.id));

        results.thankYous++;
      } catch (err) {
        console.error(`[booking-emails] Erreur remerciement booking ${booking.id}:`, err);
        results.errors++;
      }
    }
  } catch (err) {
    console.error("[booking-emails] Erreur requête remerciements:", err);
    results.errors++;
  }

  return NextResponse.json(results);
}
