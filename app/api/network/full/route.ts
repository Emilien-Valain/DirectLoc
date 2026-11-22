import { type NextRequest, NextResponse } from "next/server";
import { findNearbySlots, findShareProposal, findVoisins, pickVoisins } from "@/lib/network";
import { parisToday } from "@/lib/date-windows";
import { isStayTooLong, isUuid, MAX_PARTY } from "@/lib/validation";

/**
 * GET /api/network/full?from=YYYY-MM-DD&to=YYYY-MM-DD&adults=N[&minors=M]
 *
 * Bloc « Complet du … » du site public : créneaux proches chez l'hôte (±7 jours, même durée) et
 * Voisins qui logent tout le groupe (ADR-0013). Faits publics seulement, jamais de prix.
 * tenantId injecté par le proxy via x-tenant-id.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const from = searchParams.get("from") ?? "";
  const to = searchParams.get("to") ?? "";
  const tenantId = request.headers.get("x-tenant-id");
  const bad = (error: string) => NextResponse.json({ error }, { status: 400 });

  if (!tenantId || !isUuid(tenantId)) return bad("Identifiant invalide");
  const checkIn = new Date(from + "T00:00:00.000Z");
  const checkOut = new Date(to + "T00:00:00.000Z");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || isNaN(checkIn.getTime()) || isNaN(checkOut.getTime())) {
    return bad("Dates invalides. Format attendu : YYYY-MM-DD");
  }
  if (checkOut <= checkIn || isStayTooLong(checkIn, checkOut)) return bad("Dates invalides");
  const adults = Number(searchParams.get("adults") ?? "1");
  const minors = Number(searchParams.get("minors") ?? "0");
  if (!Number.isInteger(adults) || !Number.isInteger(minors) || adults < 1 || minors < 0 || adults + minors > MAX_PARTY) {
    return bad("Nombre de voyageurs invalide");
  }

  const q = { checkIn, checkOut, adults, minors };
  const [slots, voisins] = await Promise.all([
    findNearbySlots({ ...q, tenantId, today: parisToday() }),
    findVoisins({ ...q, originTenantId: tenantId }),
  ]);
  const whole = pickVoisins(voisins);
  // Partage : seulement si ni dates proches ni Voisin ne logent tout le groupe.
  const proposal = slots.length === 0 && whole.length === 0 ? await findShareProposal({ ...q, originTenantId: tenantId }) : null;
  return NextResponse.json({
    slots,
    voisins: whole.map((v) => ({ name: v.name, city: v.city, distanceKm: v.distanceKm, slug: v.slug })),
    share: proposal && {
      voisin: { name: proposal.voisin.name, city: proposal.voisin.city, distanceKm: proposal.voisin.distanceKm, slug: proposal.voisin.slug },
      host: proposal.plan.host,
      rest: proposal.plan.rest,
    },
  });
}
