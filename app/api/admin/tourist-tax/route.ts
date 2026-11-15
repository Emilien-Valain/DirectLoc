import { headers } from "next/headers";
import { and, asc, eq, gte, inArray, lt } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookingLines, bookings } from "@/db/schema";

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const parse = (v: string | null) => {
  if (!v || !ISO.test(v)) return null;
  const d = new Date(v + "T00:00:00.000Z");
  // 2026-02-31 passe la regex mais pas l'aller-retour.
  return isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v ? null : d;
};
const frDate = (d: Date) => new Date(d).toLocaleDateString("fr-FR", { timeZone: "UTC" });
const frAmount = (n: number) => n.toFixed(2).replace(".", ",");

/**
 * Export de la taxe de séjour (ADR-0011) : une ligne par séjour confirmé ou terminé
 * dont le départ tombe dans [from, to] (inclus). CSV pour Excel FR : BOM UTF-8, « ; ».
 */
export async function GET(request: Request) {
  const tenantId = (await headers()).get("x-tenant-id");
  if (!tenantId) return new Response("Unauthorized", { status: 401 });

  const url = new URL(request.url);
  const from = parse(url.searchParams.get("from"));
  const to = parse(url.searchParams.get("to"));
  if (!from || !to || to < from) {
    return new Response("Période invalide : dates au format AAAA-MM-JJ, la fin après le début.", {
      status: 400,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  const end = new Date(to.getTime() + 86400000);

  const rows = await db
    .select({
      checkIn: bookings.checkIn,
      checkOut: bookings.checkOut,
      guestCount: bookings.guestCount,
      childCount: bookings.childCount,
      taxTotal: bookingLines.total,
      exempt: bookingLines.exempt,
    })
    .from(bookings)
    .leftJoin(bookingLines, and(eq(bookingLines.bookingId, bookings.id), eq(bookingLines.kind, "tax")))
    .where(
      and(
        eq(bookings.tenantId, tenantId),
        inArray(bookings.status, ["confirmed", "completed"]),
        gte(bookings.checkOut, from),
        lt(bookings.checkOut, end),
      ),
    )
    .orderBy(asc(bookings.checkOut), asc(bookings.checkIn));

  let totalCents = 0;
  const lines = [["Arrivée", "Départ", "Nuits", "Adultes", "Mineurs exonérés", "Exonération hôte", "Montant collecté (€)"]];
  for (const r of rows) {
    const amount = r.taxTotal ? parseFloat(r.taxTotal) : 0;
    totalCents += Math.round(amount * 100);
    lines.push([
      frDate(r.checkIn),
      frDate(r.checkOut),
      String(Math.round((new Date(r.checkOut).getTime() - new Date(r.checkIn).getTime()) / 86400000)),
      String(Math.max(0, r.guestCount - r.childCount)),
      String(r.childCount),
      r.exempt ? "oui" : "non",
      frAmount(amount),
    ]);
  }
  lines.push(["Total", "", "", "", "", "", frAmount(totalCents / 100)]);

  // Que des dates et des nombres : aucune saisie libre, donc rien à échapper.
  const csv = "﻿" + lines.map((l) => l.join(";")).join("\r\n") + "\r\n";
  const name = `taxe-de-sejour_${url.searchParams.get("from")}_${url.searchParams.get("to")}.csv`;
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "no-store",
    },
  });
}
