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

/** Maximum qu'un hôte peut fixer pour une option « par séjour » (2 paniers, 4 vélos…). */
export const MAX_CHOSEN = 99;

/** Ce que le séjour offre à choisir : nuits, voyageurs, lits de la chambre. */
export type StaySize = { nights: number; guests: number; beds: number };

/**
 * Nombre que le client peut choisir, calé sur le séjour selon l'unité : nuits (par nuit),
 * voyageurs (par personne, par personne et par nuit), lits (par lit). « Par séjour » :
 * le maximum fixé par l'hôte (absent = 1, pas de choix).
 */
export function chosenMax(extra: { unit: ExtraUnit; maxQuantity?: number | null }, stay: StaySize): number {
  const n = (() => {
    switch (extra.unit) {
      case "per_stay":
        return Math.min(MAX_CHOSEN, extra.maxQuantity ?? 1);
      case "per_night":
        return stay.nights;
      case "per_guest":
      case "per_guest_night":
        return stay.guests;
      case "per_bed":
        return stay.beds;
    }
  })();
  return Math.max(1, Math.floor(n) || 1);
}

/** Ce que le client choisit : des nuits, des personnes, des lits, ou un nombre (par séjour). */
export const CHOSEN_WORDS: Record<ExtraUnit, { question: string; one: string; many: string }> = {
  per_stay: { question: "Combien ?", one: "", many: "" },
  per_night: { question: "Pour combien de nuits ?", one: "nuit", many: "nuits" },
  per_guest: { question: "Pour combien de personnes ?", one: "personne", many: "personnes" },
  per_guest_night: { question: "Pour combien de personnes ?", one: "personne", many: "personnes" },
  per_bed: { question: "Pour combien de lits ?", one: "lit", many: "lits" },
};

export const chosenLabel = (unit: ExtraUnit, n: number) => {
  const w = CHOSEN_WORDS[unit];
  return w.one ? `${n} ${n > 1 ? w.many : w.one}` : String(n);
};

/**
 * Nombre retenu pour une ligne. `null` = tout le séjour (toutes les nuits, personnes ou
 * lits) : il suit le séjour si l'hôte l'allonge. « Par séjour » : toujours un nombre (1 par défaut).
 * Demandé > enregistré > défaut ; ramené dans [1, max] ; égal au max → `null`.
 */
export function resolveChosen(
  unit: ExtraUnit,
  max: number,
  requested?: number,
  stored?: number | null,
): number | null {
  const clamp = (n: number) => Math.min(max, Math.max(1, Math.floor(n)));
  let c: number | null;
  if (requested !== undefined && Number.isFinite(requested)) c = clamp(requested);
  else if (stored !== undefined && stored !== null) c = clamp(stored);
  else c = unit === "per_stay" ? 1 : null;
  return unit !== "per_stay" && c === max ? null : c;
}

/** Lits proposables pour une option « par lit » : lits renseignés, sinon la capacité. */
export const bedLimit = (room: { beds: number | null; capacity: number }) =>
  Math.max(1, room.beds ?? room.capacity);

/** Champs `extraQty_<id>` d'un formulaire → { id: nombre choisi }. */
export function extraQuantitiesFrom(entries: Iterable<[string, FormDataEntryValue]>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of entries) {
    if (k.startsWith("extraQty_") && typeof v === "string" && v.trim() !== "") out[k.slice(9)] = Number(v);
  }
  return out;
}

/**
 * Quantité d'une ligne selon l'unité ; `chosen` (déjà borné) remplace la dimension choisie,
 * `null` = tout le séjour. Par personne et par nuit : personnes choisies × nuits.
 */
export function extraQuantity(unit: ExtraUnit, stay: StaySize, chosen: number | null = null): number {
  switch (unit) {
    case "per_stay":
      return chosen ?? 1;
    case "per_night":
      return chosen ?? stay.nights;
    case "per_guest":
      return chosen ?? stay.guests;
    case "per_guest_night":
      return (chosen ?? stay.guests) * stay.nights;
    case "per_bed":
      return chosen ?? stay.beds;
  }
}

export type ExtraLine = {
  /** Extra du catalogue (null s'il a été supprimé depuis). */
  sourceId: string | null;
  label: string;
  unit: ExtraUnit;
  unitPrice: number;
  /** Nombre choisi par le client ; null ou absent = tout le séjour (voir `resolveChosen`). */
  chosen?: number | null;
  quantity: number;
  total: number;
};

/** Ligne d'une réservation, quel que soit son type (ADR-0011) : ce qu'admitBooking enregistre. */
export type StayLine = ExtraLine & { kind: "extra" | "fee" | "tax"; exempt: boolean };

const cents = (n: number) => Math.round(n * 100);

/** Une ligne au prix donné (catalogue ou figé), quantité recalculée. Montants au centime. */
export function priceExtraLine(
  extra: { sourceId: string | null; label: string; unit: ExtraUnit; unitPrice: number },
  stay: StaySize,
  chosen: number | null = null,
): ExtraLine {
  const quantity = extraQuantity(extra.unit, stay, chosen);
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
