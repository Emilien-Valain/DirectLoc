/**
 * Taxe de séjour au réel (ADR-0011) — pur, partagé client et serveur : le récap
 * public et le montant encaissé sortent de la même fonction.
 *
 * - fixed : montant × adultes × nuits (hébergement classé).
 * - percentage : par nuit, min(plafond, taux × prixHT / occupants) × adultes, puis
 *   taxes additionnelles (départementale 10 %, régionale…) en sus. Mineurs comptés
 *   dans les occupants mais exonérés. prixHT = prix de la nuit ÷ (1 + TVA hébergement).
 */

export type TouristTax =
  | { mode: "fixed"; amount: number }
  | { mode: "percentage"; rate: number; cap: number; vat: number; additional: number };

export const TOURIST_TAX_LABEL = "Taxe de séjour";

export type TaxLine = {
  sourceId: null;
  label: string;
  unit: "per_guest_night";
  /** Montant moyen par adulte et par nuit (affichage) ; le total fait foi. */
  unitPrice: number;
  /** Adultes × nuits. */
  quantity: number;
  total: number;
  exempt: boolean;
};

/** null = taxe désactivée. `waived` : exonération posée par l'hôte → ligne gardée à 0 €. */
export function touristTaxLine(
  tax: TouristTax | undefined,
  nightPrices: number[],
  guests: number,
  children: number,
  waived = false,
): TaxLine | null {
  if (!tax) return null;
  const adults = Math.max(0, guests - children);
  const quantity = adults * nightPrices.length;
  let totalCents = 0;
  if (!waived && quantity > 0) {
    if (tax.mode === "fixed") {
      totalCents = Math.round(tax.amount * 100) * quantity;
    } else {
      const perAdultNights = nightPrices.reduce((sum, price) => {
        const perPersonHT = price / (1 + tax.vat / 100) / Math.max(1, guests);
        return sum + Math.min(tax.cap, (tax.rate / 100) * perPersonHT);
      }, 0);
      totalCents = Math.round(perAdultNights * adults * (1 + tax.additional / 100) * 100);
    }
  }
  return {
    sourceId: null,
    label: TOURIST_TAX_LABEL,
    unit: "per_guest_night",
    unitPrice: quantity > 0 ? Math.round(totalCents / quantity) / 100 : 0,
    quantity,
    total: totalCents / 100,
    exempt: waived,
  };
}
