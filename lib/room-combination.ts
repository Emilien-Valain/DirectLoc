/**
 * Moteur de combinaison de chambres (Dossier, ADR-0012) — module PUR : aucun accès DB,
 * aucun rendu. Réutilisable côté serveur pour un autre tenant (réseau, ADR-0013).
 *
 * Entrée : les chambres candidates déjà libres pour [checkIn, checkOut) (Holds), avec le
 * prix total du séjour et, si une règle de réservation (nuits min…) les refuse, une raison
 * d'exclusion. Voir `lib/room-combination-candidates.ts` pour l'adaptateur DB.
 *
 * Répartition des personnes (déterministe) :
 *  1. Les personnes (adultes + mineurs) remplissent les chambres de la plus grande capacité
 *     à la plus petite (égalité : id croissant). Comme la combinaison a le MINIMUM de
 *     chambres, aucune chambre ne reste vide (sinon une combinaison plus petite existerait).
 *  2. Adultes : chaque chambre DOIT avoir ≥ 1 adulte (décision produit) : une combinaison
 *     n'est admissible que si son nombre de chambres ≤ adultes. 1 adulte par chambre d'abord,
 *     puis les adultes restants remplissent les places libres dans le même ordre.
 *  3. Les places restantes sont des mineurs.
 */

/** Plafond de chambres examinées (garde-fou : la recherche reste en O(n²·personnes)). */
export const MAX_CANDIDATE_ROOMS = 30;

/** Règles qui écartent des chambres pourtant libres (« Séjour minimum de 2 nuits »…), sans doublon. */
export function ruleReasons(candidates: Pick<RoomCandidate, "excludedReason">[]): string[] {
  return [...new Set(candidates.flatMap((c) => (c.excludedReason ? [c.excludedReason] : [])))].slice(0, 3);
}

export interface RoomCandidate {
  id: string;
  capacity: number;
  /** Prix total du séjour pour cette chambre (€). */
  totalPrice: number;
  /** Si renseigné, la chambre est refusée par une règle (ex. séjour minimum) : jamais proposée. */
  excludedReason?: string;
}

export interface RoomAssignment {
  roomId: string;
  /** Personnes dans la chambre (adultes + mineurs). */
  guests: number;
  adults: number;
  minors: number;
}

export type CombinationResult =
  | {
      ok: true;
      rooms: (RoomAssignment & { capacity: number; totalPrice: number })[];
      totalPrice: number;
      totalCapacity: number;
    }
  | {
      ok: false;
      reason: "insufficient_capacity";
      /** Capacité max atteignable avec les chambres non exclues (utilisée par le réseau). */
      maxCapacity: number;
    }
  | {
      ok: false;
      reason: "not_enough_adults";
      /** Capacité max atteignable avec au plus `adults` chambres (1 adulte minimum par chambre). */
      maxCapacity: number;
    }
  | { ok: false; reason: "invalid_input"; message: string; maxCapacity: 0 };

const isCount = (n: number) => Number.isInteger(n) && n >= 0;
const cents = (n: number) => Math.round(n * 100);

interface Cell {
  cents: number;
  ids: string[];
}

export function suggestCombination(
  candidates: RoomCandidate[],
  adults: number,
  minors: number,
): CombinationResult {
  if (!isCount(adults) || !isCount(minors)) {
    return { ok: false, reason: "invalid_input", message: "Nombre de personnes invalide", maxCapacity: 0 };
  }
  if (adults < 1) {
    return { ok: false, reason: "invalid_input", message: "Au moins un adulte est requis", maxCapacity: 0 };
  }
  const people = adults + minors;

  const usable = candidates
    .filter((c) => !c.excludedReason && Number.isInteger(c.capacity) && c.capacity >= 1)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, MAX_CANDIDATE_ROOMS);
  const maxCapacity = usable.reduce((s, c) => s + c.capacity, 0);
  if (people > maxCapacity) return { ok: false, reason: "insufficient_capacity", maxCapacity };

  const maxRooms = Math.min(usable.length, adults);
  // dp[k][c] = combinaison la moins chère de k chambres de capacité cumulée min(c, people)
  // (c = people signifie « au moins people »). Knapsack 0/1 en place, k et c décroissants.
  const n = usable.length;
  const dp: (Cell | null)[][] = Array.from({ length: n + 1 }, () => Array<Cell | null>(people + 1).fill(null));
  dp[0][0] = { cents: 0, ids: [] };
  for (const room of usable) {
    const p = cents(room.totalPrice);
    for (let k = maxRooms - 1; k >= 0; k--) {
      for (let c = people; c >= 0; c--) {
        const from = dp[k][c];
        if (!from) continue;
        const to = Math.min(people, c + room.capacity);
        const cand = from.cents + p;
        const cur = dp[k + 1][to];
        // Strict : à prix égal, la première combinaison trouvée (ordre d'id) est conservée.
        if (!cur || cand < cur.cents) dp[k + 1][to] = { cents: cand, ids: [...from.ids, room.id] };
      }
    }
  }
  let best: Cell | null = null;
  for (let k = 1; k <= maxRooms && !best; k++) best = dp[k][people];
  if (!best) {
    // Capacité suffisante, mais pas avec ≤ `adults` chambres.
    const capped = usable
      .map((r) => r.capacity)
      .sort((a, b) => b - a)
      .slice(0, adults)
      .reduce((a, b) => a + b, 0);
    return { ok: false, reason: "not_enough_adults", maxCapacity: capped };
  }

  const byId = new Map(usable.map((r) => [r.id, r]));
  const chosen = best.ids.map((id) => byId.get(id)!);
  const split = new Map(distributeGuests(chosen, adults, minors).map((a) => [a.roomId, a]));

  return {
    ok: true,
    rooms: sortForFill(chosen).map((r) => ({ ...split.get(r.id)!, capacity: r.capacity, totalPrice: r.totalPrice })),
    totalPrice: best.cents / 100,
    totalCapacity: chosen.reduce((s, r) => s + r.capacity, 0),
  };
}

const sortForFill = <T extends { id: string; capacity: number }>(rooms: T[]) =>
  [...rooms].sort((a, b) => b.capacity - a.capacity || (a.id < b.id ? -1 : 1));

/**
 * Répartition automatique (voir l'en-tête) des personnes sur des chambres données, dans
 * l'ordre reçu. Sert à la suggestion ET quand le voyageur ajoute, retire ou échange une
 * chambre. Si la capacité manque, les chambres sont pleines et le reste n'est pas logé ;
 * s'il y a moins d'adultes que de chambres, certaines restent sans adulte : à
 * `validateCombination` de le dire.
 */
export function distributeGuests(
  rooms: { id: string; capacity: number }[],
  adults: number,
  minors: number,
): RoomAssignment[] {
  const order = sortForFill(rooms);
  let left = Math.max(0, adults) + Math.max(0, minors);
  const guests = new Map<string, number>();
  for (const r of order) {
    const g = Math.max(0, Math.min(r.capacity, left));
    left -= g;
    guests.set(r.id, g);
  }
  let adultsLeft = Math.max(0, adults);
  const adultsPer = new Map<string, number>();
  for (const r of order) {
    const one = adultsLeft > 0 && guests.get(r.id)! > 0 ? 1 : 0;
    adultsLeft -= one;
    adultsPer.set(r.id, one);
  }
  for (const r of order) {
    const extra = Math.min(adultsLeft, guests.get(r.id)! - adultsPer.get(r.id)!);
    adultsPer.set(r.id, adultsPer.get(r.id)! + extra);
    adultsLeft -= extra;
  }
  return rooms.map((r) => ({
    roomId: r.id,
    guests: guests.get(r.id)!,
    adults: adultsPer.get(r.id)!,
    minors: guests.get(r.id)! - adultsPer.get(r.id)!,
  }));
}

export type CombinationError =
  | { code: "invalid_input" }
  | { code: "empty" }
  | { code: "duplicate_room"; roomId: string }
  | { code: "unknown_room"; roomId: string }
  | { code: "room_excluded"; roomId: string; reason: string }
  | { code: "invalid_count"; roomId: string }
  | { code: "empty_room"; roomId: string }
  | { code: "over_capacity"; roomId: string; capacity: number }
  | { code: "minors_exceed_guests"; roomId: string }
  | { code: "no_adult"; roomId: string }
  | { code: "insufficient_capacity"; capacity: number; people: number }
  | { code: "people_mismatch"; expected: number; actual: number }
  | { code: "minors_mismatch"; expected: number; actual: number };

export type ValidationResult =
  | { ok: true; totalPrice: number; totalCapacity: number }
  | { ok: false; errors: CombinationError[] };

/**
 * Valide une combinaison modifiée par le voyageur. `assignments[i].guests` = personnes
 * (adultes + mineurs) dans la chambre, `minors` ⊂ guests ; chaque chambre exige ≥ 1 adulte.
 */
export function validateCombination(
  candidates: RoomCandidate[],
  assignments: { roomId: string; guests: number; minors: number }[],
  adults: number,
  minors: number,
): ValidationResult {
  if (!isCount(adults) || !isCount(minors) || adults + minors < 1) {
    return { ok: false, errors: [{ code: "invalid_input" }] };
  }
  const people = adults + minors;
  const errors: CombinationError[] = [];
  if (assignments.length === 0) return { ok: false, errors: [{ code: "empty" }] };

  const byId = new Map(candidates.map((c) => [c.id, c]));
  const seen = new Set<string>();
  let totalPrice = 0;
  let totalCapacity = 0;
  let sumGuests = 0;
  let sumMinors = 0;
  for (const a of assignments) {
    if (seen.has(a.roomId)) {
      errors.push({ code: "duplicate_room", roomId: a.roomId });
      continue;
    }
    seen.add(a.roomId);
    const room = byId.get(a.roomId);
    if (!room) {
      errors.push({ code: "unknown_room", roomId: a.roomId });
      continue;
    }
    if (room.excludedReason) errors.push({ code: "room_excluded", roomId: a.roomId, reason: room.excludedReason });
    totalPrice += cents(room.totalPrice);
    totalCapacity += room.capacity;
    if (!isCount(a.guests) || !isCount(a.minors)) {
      errors.push({ code: "invalid_count", roomId: a.roomId });
      continue;
    }
    if (a.guests < 1) errors.push({ code: "empty_room", roomId: a.roomId });
    if (a.guests > room.capacity) errors.push({ code: "over_capacity", roomId: a.roomId, capacity: room.capacity });
    if (a.minors > a.guests) errors.push({ code: "minors_exceed_guests", roomId: a.roomId });
    else if (a.guests >= 1 && a.guests - a.minors < 1) errors.push({ code: "no_adult", roomId: a.roomId });
    sumGuests += a.guests;
    sumMinors += a.minors;
  }
  if (totalCapacity < people) errors.push({ code: "insufficient_capacity", capacity: totalCapacity, people });
  if (errors.length === 0) {
    if (sumGuests !== people) errors.push({ code: "people_mismatch", expected: people, actual: sumGuests });
    if (sumMinors !== minors) errors.push({ code: "minors_mismatch", expected: minors, actual: sumMinors });
  }
  return errors.length
    ? { ok: false, errors }
    : { ok: true, totalPrice: totalPrice / 100, totalCapacity };
}
