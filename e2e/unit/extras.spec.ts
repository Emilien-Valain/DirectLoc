import { test, expect } from "@playwright/test";
import { balanceDue, extraQuantity, grandTotal, priceExtraLine } from "../../lib/extras";

/**
 * Spécification : Tests de non-régression > Extras > Calcul (ADR-0010)
 * Fonction pure partagée par le récap public, le devis admin et l'admission serveur.
 */

const line = (unit: Parameters<typeof extraQuantity>[0], unitPrice: number, nights: number, guests: number) =>
  priceExtraLine({ sourceId: null, label: "x", unit, unitPrice }, nights, guests);

test.describe("Extras — calcul", () => {
  test("quantité dérivée des 4 unités", () => {
    expect(extraQuantity("per_stay", 3, 2)).toBe(1);
    expect(extraQuantity("per_night", 3, 2)).toBe(3);
    expect(extraQuantity("per_guest", 3, 2)).toBe(2);
    expect(extraQuantity("per_guest_night", 3, 2)).toBe(6);
  });

  test("limite 1 nuit / 1 personne : quantité 1 pour toutes les unités", () => {
    for (const u of ["per_stay", "per_night", "per_guest", "per_guest_night"] as const) {
      expect(extraQuantity(u, 1, 1)).toBe(1);
    }
  });

  test("montants au centime, sans dérive flottante", () => {
    expect(line("per_guest_night", 8.5, 3, 2).total).toBe(51);
    expect(line("per_night", 0.1, 3, 1).total).toBe(0.3);
    expect(grandTotal(0.1, [{ total: 0.2 }])).toBe(0.3);
    expect(grandTotal(300, [line("per_guest_night", 12.35, 7, 3)])).toBe(559.35);
  });

  test("Extra à 0 € : ligne gratuite, total inchangé", () => {
    const l = line("per_stay", 0, 4, 2);
    expect(l.total).toBe(0);
    expect(grandTotal(400, [l])).toBe(400);
  });

  test("total = somme des line items Stripe (hébergement + prix unitaire × quantité)", () => {
    const acc = 333.33;
    const lines = [line("per_guest_night", 9.99, 3, 2), line("per_stay", 15, 3, 2)];
    const stripeCents = Math.round(acc * 100) + lines.reduce((s, l) => s + Math.round(l.unitPrice * 100) * l.quantity, 0);
    expect(Math.round(grandTotal(acc, lines) * 100)).toBe(stripeCents);
  });

  test("reste à payer : total − payé en ligne ; 0 si réglé, sans paiement en ligne, ou trop-perçu", () => {
    expect(balanceDue(460, 400, null)).toBe(60);
    expect(balanceDue(460, 400, new Date())).toBe(0);
    expect(balanceDue(460, 0, null)).toBe(0);
    expect(balanceDue(380, 400, null)).toBe(0);
    expect(balanceDue(400.1, 400, null)).toBe(0.1);
  });
});
