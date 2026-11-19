/**
 * Calcul des Extras (ADR-0010) — pur, partagé client et serveur : le récap public
 * et le montant facturé sortent de la même fonction.
 */

export const EXTRA_UNITS = ["per_stay", "per_night", "per_guest", "per_guest_night", "per_bed"] as const;
export type ExtraUnit = (typeof EXTRA_UNITS)[number];

/** Unités d'un Fee : pas « par lit », dont la quantité est choisie par le client. */
export const FEE_UNITS = ["per_stay", "per_night", "per_guest", "per_guest_night"] as const;

export const EXTRA_UNIT_LABELS: Record<ExtraUnit, string> = {
  per_stay: "par séjour",
  per_night: "par nuit",
  per_guest: "par personne",
  per_guest_night: "par personne et par nuit",
  per_bed: "par lit",
};

/** Nombre qu'un hôte peut proposer au choix pour une option (2 paniers, 4 vélos…). */
export const MAX_CHOSEN = 99;

/**
 * Nombre maximum que le client peut choisir pour cette option : les lits de la chambre
 * pour « par lit », sinon le maximum fixé par l'hôte (absent = 1, pas de choix).
 */
export function chosenMax(extra: { unit: ExtraUnit; maxQuantity?: number | null }, maxBeds: number): number {
  if (extra.unit === "per_bed") return Math.max(1, maxBeds);
  return Math.min(MAX_CHOSEN, Math.max(1, extra.maxQuantity ?? 1));
}

/** Choix proposé d'office : tous les lits pour « par lit » (draps), un seul sinon. */
export const defaultChosen = (unit: ExtraUnit, max: number) => (unit === "per_bed" ? max : 1);

/** Lits proposables pour une option « par lit » : lits renseignés, sinon la capacité. */
export const bedLimit = (room: { beds: number | null; capacity: number }) =>
  Math.max(1, room.beds ?? room.capacity);

/** Nombre demandé ramené dans [1, max] ; absent ou illisible → `fallback` (défaut : max). */
export function clampQuantity(requested: number | undefined, max: number, fallback = max): number {
  if (requested === undefined || !Number.isFinite(requested)) return Math.min(max, Math.max(1, fallback));
  return Math.min(max, Math.max(1, Math.floor(requested)));
}

/** Champs `extraQty_<id>` d'un formulaire → { id: nombre choisi }. */
export function extraQuantitiesFrom(entries: Iterable<[string, FormDataEntryValue]>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of entries) {
    if (k.startsWith("extraQty_") && typeof v === "string" && v.trim() !== "") out[k.slice(9)] = Number(v);
  }
  return out;
}

/**
 * Quantité d'une ligne : quantité du séjour (1, nuits, personnes…) × nombre choisi
 * (`chosen`, déjà borné). « Par lit » : le nombre de lits choisi. `guests` compte tous les âges.
 */
export function extraQuantity(unit: ExtraUnit, nights: number, guests: number, chosen = 1): number {
  switch (unit) {
    case "per_stay":
      return chosen;
    case "per_night":
      return nights * chosen;
    case "per_guest":
      return guests * chosen;
    case "per_guest_night":
      return guests * nights * chosen;
    case "per_bed":
      return chosen;
  }
}

export type ExtraLine = {
  /** Extra du catalogue (null s'il a été supprimé depuis). */
  sourceId: string | null;
  label: string;
  unit: ExtraUnit;
  unitPrice: number;
  /** Nombre choisi par le client (absent ou 1 : l'option ne se choisit pas en nombre). */
  chosen?: number;
  quantity: number;
  total: number;
};

/** Ligne d'une réservation, quel que soit son type (ADR-0011) : ce qu'admitBooking enregistre. */
export type StayLine = ExtraLine & { kind: "extra" | "fee" | "tax"; exempt: boolean };

const cents = (n: number) => Math.round(n * 100);

/** Une ligne au prix donné (catalogue ou figé), quantité recalculée. Montants au centime. */
export function priceExtraLine(
  extra: { sourceId: string | null; label: string; unit: ExtraUnit; unitPrice: number },
  nights: number,
  guests: number,
  chosen = 1,
): ExtraLine {
  const quantity = extraQuantity(extra.unit, nights, guests, chosen);
  return { ...extra, unitPrice: cents(extra.unitPrice) / 100, chosen, quantity, total: (cents(extra.unitPrice) * quantity) / 100 };
}

/** Hébergement + lignes, additionnés en centimes (pas de 0,1 + 0,2). */
export function grandTotal(accommodation: number, lines: { total: number }[]): number {
  return (cents(accommodation) + lines.reduce((s, l) => s + cents(l.total), 0)) / 100;
}

/**
 * Reste à payer (Balance due) : total − payé en ligne, jamais négatif ;
 * 0 dès que l'hôte a noté le règlement hors ligne (`paidAt`) ou sans paiement en ligne
 * (une saisie manuelle se suit avec « À régler », pas avec un reste).
 */
export function balanceDue(total: number, paidOnline: number, paidAt: Date | null): number {
  if (paidAt || paidOnline <= 0) return 0;
  return Math.max(0, (cents(total) - cents(paidOnline)) / 100);
}

/** Un Fee (ADR-0011) s'applique-t-il à cette chambre ? `roomIds` vide = toutes. */
export const feeAppliesTo = (fee: { roomIds: string[] }, roomId: string) =>
  fee.roomIds.length === 0 || fee.roomIds.includes(roomId);
