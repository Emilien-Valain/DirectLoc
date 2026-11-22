import { test, expect } from "@playwright/test";
import { amountField, cancellationRefund, parseRefundAmount, refundSuggestion, uniqueShortcuts } from "../../lib/refund-amounts";
import { dossierMoney } from "../../lib/queries/dossiers";

/**
 * Spécification : Tests de non-régression > Remboursements > Montants (pur)
 * Référence : .scratch/remboursements-litiges/issues/02-refunds.md
 */

test.describe("parseRefundAmount — saisie de l'hôte en centimes", () => {
  test("formats acceptés", () => {
    expect(parseRefundAmount("45")).toBe(4500);
    expect(parseRefundAmount("45,50")).toBe(4550);
    expect(parseRefundAmount("45.5")).toBe(4550);
    expect(parseRefundAmount(" 1 234,56 € ")).toBe(123456);
    expect(parseRefundAmount("0,01")).toBe(1);
  });
  test("refusés : vide, 0, négatif, texte, trop de décimales, notation scientifique, XSS", () => {
    for (const bad of ["", "0", "0,00", "-5", "abc", "12,345", "1e3", "12..5", "<script>alert(1)</script>", null, undefined, "Infinity", "NaN"]) {
      expect(parseRefundAmount(bad), String(bad)).toBeNull();
    }
  });
  test("amountField : centimes → champ", () => {
    expect(amountField(13500)).toBe("135");
    expect(amountField(6750)).toBe("67,50");
    expect(amountField(1)).toBe("0,01");
  });
});

test.describe("Suggestion selon le niveau d'annulation du Dossier", () => {
  const checkIn = new Date("2027-03-10T00:00:00Z");
  test("modérée à J-5 → 50 %, libellé des conditions", () => {
    const s = refundSuggestion("moderate", checkIn, new Date("2027-03-05T10:00:00Z"), 30000, 30000)!;
    expect(s.amount).toBe(15000);
    expect(s.label).toBe("50 % selon vos conditions (modérée, moins de 7 jours)");
    expect(s.note).toBeUndefined();
  });
  test("modérée à J-10 → 100 % ; plafonnée au restant remboursable", () => {
    expect(refundSuggestion("moderate", checkIn, new Date("2027-02-28T10:00:00Z"), 30000, 30000)!.amount).toBe(30000);
    expect(refundSuggestion("moderate", checkIn, new Date("2027-02-28T10:00:00Z"), 30000, 12000)!.amount).toBe(12000);
  });
  test("personnalisé → total + « vérifiez le montant »", () => {
    const s = refundSuggestion("custom", checkIn, new Date("2027-03-09T10:00:00Z"), 30000, 30000)!;
    expect(s).toEqual({ label: "Total, conditions personnalisées", amount: 30000, note: "Conditions personnalisées, vérifiez le montant." });
  });
  test("sans conditions acceptées ou rien à rembourser → pas de suggestion", () => {
    expect(refundSuggestion(null, checkIn, new Date(), 30000, 30000)).toBeNull();
    expect(refundSuggestion("moderate", checkIn, new Date(), 30000, 0)).toBeNull();
  });
  test("case d'annulation : défaut = suggestion, sinon le prix annulé ; raccourcis sans doublon ni 0 €", () => {
    const at = new Date("2027-03-05T10:00:00Z");
    expect(cancellationRefund({ level: "moderate", checkIn, now: at, base: 12000, baseLabel: "Prix de la chambre", refundable: 30000 })).toEqual({
      defaultAmount: 6000,
      shortcuts: [
        { label: "50 % selon vos conditions (modérée, moins de 7 jours)", amount: 6000 },
        { label: "Prix de la chambre", amount: 12000 },
        { label: "Tout le restant", amount: 30000 },
      ],
    });
    // Stricte à J-5 : 0 % → case décochée par défaut, pas de raccourci à 0 €.
    const strict = cancellationRefund({ level: "strict", checkIn, now: at, base: 12000, baseLabel: "Prix de la chambre", refundable: 30000 });
    expect(strict.defaultAmount).toBe(0);
    expect(strict.shortcuts.map((s) => s.amount)).toEqual([12000, 30000]);
    expect(cancellationRefund({ level: null, checkIn, now: at, base: 50000, baseLabel: "Tout le paiement", refundable: 30000 }).defaultAmount).toBe(30000);
    expect(uniqueShortcuts([null, false, { label: "A", amount: 0 }, { label: "B", amount: 5 }, { label: "C", amount: 5 }])).toEqual([{ label: "B", amount: 5 }]);
  });
});

test.describe("dossierMoney — encaissé net, reste à payer, trop-perçu", () => {
  const rooms = (...totals: [string, string][]) => totals.map(([totalPrice, status]) => ({ totalPrice, status, paidAt: null }));
  const paid = { status: "paid", amount: "300.00" };
  test("chambre annulée après paiement : trop-perçu, puis remboursé → plus rien", () => {
    const r = rooms(["180.00", "confirmed"], ["120.00", "cancelled"]);
    expect(dossierMoney(r, paid)).toMatchObject({ due: 180, net: 300, refund: 120, balance: 0, refundable: 300 });
    expect(dossierMoney(r, paid, 120)).toMatchObject({ due: 180, refunded: 120, net: 180, refund: 0, balance: 0, refundable: 180 });
  });
  test("un remboursement ne crée jamais de reste à payer : geste commercial, chambre annulée rendue, rendu au-delà du trop-perçu", () => {
    const pay540 = { status: "paid", amount: "540.00" };
    // Geste de 45,50 € sur 540 € payés, séjour maintenu.
    expect(dossierMoney(rooms(["540.00", "confirmed"]), pay540, 45.5)).toMatchObject({ net: 494.5, balance: 0, refund: 0 });
    // Chambre annulée (dû 270) remboursée 270 sur 540.
    const two = rooms(["270.00", "confirmed"], ["270.00", "cancelled"]);
    expect(dossierMoney(two, pay540, 270)).toMatchObject({ due: 270, net: 270, balance: 0, refund: 0 });
    // Chambre annulée non remboursée : trop-perçu 270.
    expect(dossierMoney(two, pay540)).toMatchObject({ net: 540, balance: 0, refund: 270 });
    // Tout rendu, séjour maintenu : rien à payer.
    expect(dossierMoney(rooms(["300.00", "confirmed"]), paid, 300)).toMatchObject({ net: 0, balance: 0, refund: 0 });
    expect(dossierMoney(rooms(["300.00", "confirmed"]), paid, 50)).toMatchObject({ net: 250, balance: 0, refund: 0 });
  });
  test("reste à payer = dû − payé brut : extras ajoutés après le paiement", () => {
    expect(dossierMoney(rooms(["330.00", "confirmed"]), paid)).toMatchObject({ balance: 30, refund: 0 });
    expect(dossierMoney(rooms(["330.00", "confirmed"]), paid, 100)).toMatchObject({ balance: 30, refund: 0 });
  });
  test("sans paiement en ligne : rien de remboursé ni de reste compté", () => {
    expect(dossierMoney(rooms(["300.00", "confirmed"]), undefined, 50)).toMatchObject({ paidOnline: 0, refunded: 0, net: 0, balance: 0, refund: 0 });
  });
});
