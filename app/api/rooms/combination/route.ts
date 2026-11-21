import { type NextRequest, NextResponse } from "next/server";
import { loadRoomCandidates } from "@/lib/room-combination-candidates";
import { ruleReasons, suggestCombination } from "@/lib/room-combination";
import { isStayTooLong, isUuid, MAX_PARTY, STAY_TOO_LONG_MESSAGE } from "@/lib/validation";

/**
 * GET /api/rooms/combination?from=YYYY-MM-DD&to=YYYY-MM-DD&adults=N[&minors=M]
 *
 * Combinaison de chambres proposée pour un groupe (Dossier, ADR-0012) : le moins de
 * chambres, puis la moins chère, chaque chambre avec au moins un adulte. Sinon la raison
 * (`insufficient_capacity`, `not_enough_adults`), la capacité max atteignable et `rules` : les
 * règles qui écartent des chambres libres (« Séjour minimum de 2 nuits »), à montrer au voyageur.
 * tenantId injecté par le proxy via x-tenant-id. Champs publics seulement.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const from = searchParams.get("from");
  const to = searchParams.get("to");
  const tenantId = request.headers.get("x-tenant-id");

  if (!from || !to || !tenantId) {
    return NextResponse.json({ error: "Paramètres manquants : from, to requis" }, { status: 400 });
  }
  if (!isUuid(tenantId)) {
    return NextResponse.json({ error: "Identifiant invalide" }, { status: 400 });
  }
  const checkIn = new Date(from + "T00:00:00.000Z");
  const checkOut = new Date(to + "T00:00:00.000Z");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || isNaN(checkIn.getTime()) || isNaN(checkOut.getTime())) {
    return NextResponse.json({ error: "Dates invalides. Format attendu : YYYY-MM-DD" }, { status: 400 });
  }
  if (checkOut <= checkIn) {
    return NextResponse.json({ error: "La date de départ doit être après la date d'arrivée" }, { status: 400 });
  }
  if (isStayTooLong(checkIn, checkOut)) {
    return NextResponse.json({ error: STAY_TOO_LONG_MESSAGE }, { status: 400 });
  }

  const adults = Number(searchParams.get("adults") ?? "1");
  const minors = Number(searchParams.get("minors") ?? "0");
  if (
    !Number.isInteger(adults) || !Number.isInteger(minors) ||
    adults < 1 || minors < 0 || adults + minors > MAX_PARTY
  ) {
    return NextResponse.json({ error: `Nombre de voyageurs invalide (1 adulte minimum, ${MAX_PARTY} personnes maximum)` }, { status: 400 });
  }

  const candidates = await loadRoomCandidates(tenantId, checkIn, checkOut);
  const result = suggestCombination(candidates, adults, minors);
  if (!result.ok) {
    return NextResponse.json({ ok: false, reason: result.reason, maxCapacity: result.maxCapacity, rules: ruleReasons(candidates) });
  }
  const byId = new Map(candidates.map((c) => [c.id, c]));
  return NextResponse.json({
    ok: true,
    totalPrice: result.totalPrice,
    rooms: result.rooms.map((r) => ({
      id: r.roomId,
      name: byId.get(r.roomId)!.name,
      capacity: r.capacity,
      adults: r.adults,
      minors: r.minors,
      totalPrice: r.totalPrice,
    })),
  });
}
