import { test, expect } from "@playwright/test";
import { touristTaxLine, type TouristTax } from "../../lib/tourist-tax";

/**
 * Spécification : Tests de non-régression > Taxe de séjour > Calcul (ADR-0011)
 * Fonction pure partagée par le récap public, le devis admin et l'admission serveur.
 */

const fixed: TouristTax = { mode: "fixed", amount: 1.65 };
const pct = (o: Partial<Extract<TouristTax, { mode: "percentage" }>> = {}): TouristTax => ({
  mode: "percentage",
  rate: 5,
  cap: 4.9,
  vat: 10,
  additional: 0,
  ...o,
});

test.describe("Taxe de séjour — calcul", () => {
  test("désactivée → aucune ligne", () => {
    expect(touristTaxLine(undefined, [100, 100], 2, 0)).toBeNull();
  });

  test("fixe : 2 adultes + 2 enfants × 3 nuits → taxe sur 2 adultes", () => {
    const l = touristTaxLine(fixed, [100, 100, 100], 4, 2)!;
    expect(l.quantity).toBe(6);
    expect(l.total).toBe(9.9);
    expect(l.unitPrice).toBe(1.65);
  });

  test("que des enfants → 0 €, ligne gardée", () => {
    const l = touristTaxLine(fixed, [100], 2, 2)!;
    expect(l.quantity).toBe(0);
    expect(l.total).toBe(0);
  });

  test("plus d'enfants que de personnes → borné à 0 adulte", () => {
    expect(touristTaxLine(fixed, [100], 1, 5)!.total).toBe(0);
  });

  test("pourcentage sous le plafond : base HT ÷ occupants (enfants compris) × adultes", () => {
    // 110 € TTC → 100 € HT ; 4 occupants → 25 €/pers ; 5 % → 1,25 € ; × 2 adultes × 2 nuits = 5 €.
    const l = touristTaxLine(pct(), [110, 110], 4, 2)!;
    expect(l.total).toBe(5);
    expect(l.quantity).toBe(4);
  });

  test("pourcentage au plafond", () => {
    // 1100 € TTC → 1000 € HT ; 1 occupant ; 5 % = 50 € → plafonné à 4,90 €.
    expect(touristTaxLine(pct(), [1100], 1, 0)!.total).toBe(4.9);
  });

  test("TVA 0 % : la base est le prix tel quel", () => {
    expect(touristTaxLine(pct({ vat: 0 }), [80], 1, 0)!.total).toBe(4);
  });

  test("taxes additionnelles en sus du plafond", () => {
    expect(touristTaxLine(pct({ additional: 10 }), [1100], 1, 0)!.total).toBe(5.39);
  });

  test("nuits à prix différents : chaque nuit a sa base", () => {
    // 55 € HT → 2,75 € ; 220 € HT → 11 € plafonné 4,90 € ; total 7,65 €.
    expect(touristTaxLine(pct({ vat: 0 }), [55, 220], 1, 0)!.total).toBe(7.65);
  });

  test("exonérée par l'hôte → 0 €, marquée exempt, quantité conservée", () => {
    const l = touristTaxLine(fixed, [100, 100], 2, 0, true)!;
    expect(l).toMatchObject({ total: 0, exempt: true, quantity: 4 });
  });
});
