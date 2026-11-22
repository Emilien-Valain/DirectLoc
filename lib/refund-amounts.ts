import { suggestedRefund, type CancellationLevel } from "@/lib/legal-documents";

/** Calculs purs des remboursements (serveur et formulaires) : montants en centimes. */

export const cents = (euros: number | string) => Math.round(Number(euros) * 100);

/**
 * Montant saisi par l'hôte (« 12,50 », « 12.5 », « 80 », « 80 € ») → centimes. `null` si ce
 * n'est pas un montant positif à deux décimales au plus (texte, 0, négatif, « 1e3 », « 12,345 »).
 */
export function parseRefundAmount(raw: unknown): number | null {
  const s = String(raw ?? "").trim().replace(/[\s  €]/g, "").replace(",", ".");
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(s)) return null;
  const c = Math.round(parseFloat(s) * 100);
  return c > 0 ? c : null;
}

/** Centimes → valeur du champ (« 135 », « 67,50 »). */
export const amountField = (c: number) => (c % 100 === 0 ? String(c / 100) : (c / 100).toFixed(2).replace(".", ","));

export type RefundShortcut = { label: string; amount: number; note?: string };

/**
 * Suggestion des conditions d'annulation acceptées au paiement (niveau copié sur le Dossier) :
 * `base` = ce que la suggestion couvre (le paiement, ou le prix de la chambre annulée), plafonné
 * au restant remboursable. Personnalisé → tout `base` + « vérifiez le montant ». Sans conditions
 * acceptées (`level` null) → pas de suggestion.
 */
export function refundSuggestion(
  level: CancellationLevel | null | undefined,
  checkIn: Date,
  now: Date,
  base: number,
  refundable: number,
): RefundShortcut | null {
  if (!level || base <= 0 || refundable <= 0) return null;
  if (level === "custom") {
    return {
      label: "Total, conditions personnalisées",
      amount: Math.min(base, refundable),
      note: "Conditions personnalisées, vérifiez le montant.",
    };
  }
  const s = suggestedRefund(level, checkIn, now, base);
  if (!s) return null;
  return { label: s.label.charAt(0).toUpperCase() + s.label.slice(1), amount: Math.min(s.amount, refundable) };
}

/** Raccourcis sans doublon (même libellé ou même montant : le premier gagne), montants > 0. */
export function uniqueShortcuts(list: (RefundShortcut | null | undefined | false)[]): RefundShortcut[] {
  const out: RefundShortcut[] = [];
  for (const s of list) {
    if (!s || s.amount <= 0 || out.some((o) => o.label === s.label || o.amount === s.amount)) continue;
    out.push(s);
  }
  return out;
}

/**
 * Case « Rembourser X € » d'un dialog d'annulation : `base` = ce qu'on annule (prix de la chambre,
 * ou le paiement pour tout le Dossier). Défaut = la suggestion des conditions si le Dossier en a,
 * sinon `base` ; plafonné au restant remboursable.
 */
export function cancellationRefund(opts: {
  level: CancellationLevel | null | undefined;
  checkIn: Date;
  now: Date;
  base: number;
  baseLabel: string;
  refundable: number;
}) {
  const { level, checkIn, now, base, baseLabel, refundable } = opts;
  const suggestion = refundSuggestion(level, checkIn, now, base, refundable);
  const full = Math.min(base, refundable);
  return {
    defaultAmount: suggestion ? suggestion.amount : full,
    shortcuts: uniqueShortcuts([suggestion, { label: baseLabel, amount: full }, { label: "Tout le restant", amount: refundable }]),
  };
}
