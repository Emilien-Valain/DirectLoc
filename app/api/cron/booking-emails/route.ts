import { NextRequest, NextResponse } from "next/server";
import { and, eq, isNull, sql, inArray, gt, lte } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookings, dossiers } from "@/db/schema";
import { sendCheckInReminder, sendPostStayThankYou } from "@/lib/email";
import { cancelOrphanPending, completeFinishedStays, loadDossierEmailContext } from "@/lib/queries/bookings";
import { MAX_REMINDER_DAYS, reminderDays, reminderDue } from "@/lib/email-template";
import { todayStart } from "@/lib/date-windows";

/**
 * GET /api/cron/booking-emails
 *
 * Envoie les emails automatiques :
 * - Rappel avant l'arrivée (un email par Dossier, dossiers.reminderSentAt IS NULL, chambres confirmed) : J-2 par défaut,
 *   délai réglé par l'hôte (config.reminderDaysBefore, 0 = désactivé) — voir reminderDue
 * - Remerciement post-séjour (un email par Dossier, chambres confirmed/completed, checkOut = hier, dossiers.thankYouSentAt IS NULL)
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

  // ── Rappels avant l'arrivée : un email par Dossier ──────────────────────
  try {
    // Candidats : Dossiers non encore rappelés ayant une chambre confirmée qui arrive dans 1 à
    // MAX_REMINDER_DAYS jours ; le délai propre à chaque établissement est appliqué ensuite
    // (reminderDue). `createdAt` = la plus ancienne réservation du Dossier.
    const today = todayStart(now);
    const horizon = new Date(today);
    horizon.setUTCDate(horizon.getUTCDate() + MAX_REMINDER_DAYS);

    const candidates = await db
      .select({
        dossierId: dossiers.id,
        tenantId: dossiers.tenantId,
        checkIn: sql<Date>`min(${bookings.checkIn})`.mapWith(bookings.checkIn),
        createdAt: sql<Date | null>`min(${bookings.createdAt})`.mapWith(bookings.createdAt),
      })
      .from(dossiers)
      .innerJoin(bookings, eq(bookings.dossierId, dossiers.id))
      .where(
        and(
          isNull(dossiers.reminderSentAt),
          eq(bookings.status, "confirmed"),
          gt(bookings.checkIn, today),
          lte(bookings.checkIn, horizon),
        ),
      )
      .groupBy(dossiers.id, dossiers.tenantId);

    for (const d of candidates) {
      try {
        const ids = await confirmedIds(d.dossierId, ["confirmed"]);
        const ctx = await loadDossierEmailContext(ids, d.tenantId);
        if (!ctx) continue;
        const days = reminderDays(ctx.emailData.config);
        if (!reminderDue(d, today, days)) continue;
        // Réserver l'envoi avant d'écrire : un second passage (ou un cron parallèle) ne l'obtient pas.
        if (!(await claim(d.dossierId, "reminderSentAt"))) continue;
        const daysUntil = Math.round((d.checkIn.getTime() - today.getTime()) / 86_400_000);
        try {
          await sendCheckInReminder({ ...ctx.emailData, daysUntil });
        } catch (err) {
          await release(d.dossierId, "reminderSentAt");
          throw err;
        }
        results.reminders++;
      } catch (err) {
        console.error(`[booking-emails] Erreur rappel dossier ${d.dossierId}:`, err);
        results.errors++;
      }
    }
  } catch (err) {
    console.error("[booking-emails] Erreur requête rappels:", err);
    results.errors++;
  }

  // ── Remerciements post-séjour : un email par Dossier ────────────────────
  try {
    // Dossiers dont le départ était hier
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const targetDate = yesterday.toISOString().split("T")[0];

    const candidates = await db
      .selectDistinct({ dossierId: dossiers.id, tenantId: dossiers.tenantId })
      .from(dossiers)
      .innerJoin(bookings, eq(bookings.dossierId, dossiers.id))
      .where(
        and(
          inArray(bookings.status, ["confirmed", "completed"]),
          isNull(dossiers.thankYouSentAt),
          sql`DATE(${bookings.checkOut}) = ${targetDate}`,
        ),
      );

    for (const d of candidates) {
      try {
        const ids = await confirmedIds(d.dossierId, ["confirmed", "completed"]);
        const ctx = await loadDossierEmailContext(ids, d.tenantId);
        if (!ctx) continue;
        if (!(await claim(d.dossierId, "thankYouSentAt"))) continue;
        try {
          await sendPostStayThankYou(ctx.emailData);
        } catch (err) {
          await release(d.dossierId, "thankYouSentAt");
          throw err;
        }
        results.thankYous++;
      } catch (err) {
        console.error(`[booking-emails] Erreur remerciement dossier ${d.dossierId}:`, err);
        results.errors++;
      }
    }
  } catch (err) {
    console.error("[booking-emails] Erreur requête remerciements:", err);
    results.errors++;
  }

  return NextResponse.json(results);
}

/** Chambres d'un Dossier ayant l'un de ces statuts (annulées exclues). */
async function confirmedIds(dossierId: string, statuses: ("confirmed" | "completed")[]) {
  const rows = await db
    .select({ id: bookings.id })
    .from(bookings)
    .where(and(eq(bookings.dossierId, dossierId), inArray(bookings.status, statuses)));
  return rows.map((r) => r.id);
}

type Marker = "reminderSentAt" | "thankYouSentAt";

/** Réserve l'envoi : un seul appelant (cron relancé ou parallèle) obtient `true` par Dossier. */
async function claim(dossierId: string, marker: Marker): Promise<boolean> {
  const done = await db
    .update(dossiers)
    .set({ [marker]: new Date() })
    .where(and(eq(dossiers.id, dossierId), isNull(dossiers[marker])))
    .returning({ id: dossiers.id });
  return done.length > 0;
}

/** Rend l'envoi réservable si l'email n'est pas parti (SMTP en panne) : le prochain passage réessaie. */
async function release(dossierId: string, marker: Marker) {
  await db.update(dossiers).set({ [marker]: null }).where(eq(dossiers.id, dossierId));
}
