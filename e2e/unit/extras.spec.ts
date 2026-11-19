import { test, expect } from "@playwright/test";
import {
  balanceDue,
  bedLimit,
  chosenMax,
  clampQuantity,
  defaultChosen,
  extraQuantitiesFrom,
  extraQuantity,
  grandTotal,
  priceExtraLine,
} from "../../lib/extras";
import { extraSchema, feeSchema } from "../../lib/validation";

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

test.describe("Extras — par lit (quantité choisie)", () => {
  test("quantité = lits choisis, indépendante des nuits et des voyageurs", () => {
    expect(extraQuantity("per_bed", 7, 4, 2)).toBe(2);
    expect(priceExtraLine({ sourceId: null, label: "Draps", unit: "per_bed", unitPrice: 8.5 }, 3, 2, 3).total).toBe(25.5);
  });

  test("bornes : [1, lits] ; absent ou illisible → tous les lits", () => {
    expect(clampQuantity(undefined, 4)).toBe(4);
    expect(clampQuantity(NaN, 4)).toBe(4);
    expect(clampQuantity(0, 4)).toBe(1);
    expect(clampQuantity(-3, 4)).toBe(1);
    expect(clampQuantity(99, 4)).toBe(4);
    expect(clampQuantity(2.7, 4)).toBe(2);
  });

  test("lits non renseignés → capacité ; jamais moins de 1", () => {
    expect(bedLimit({ beds: null, capacity: 6 })).toBe(6);
    expect(bedLimit({ beds: 2, capacity: 6 })).toBe(2);
    expect(bedLimit({ beds: 0, capacity: 6 })).toBe(1);
  });

  test("champs extraQty_<id> lus, vides ignorés", () => {
    expect(extraQuantitiesFrom([["extraQty_a", "2"], ["extraQty_b", ""], ["extraIds", "a"]])).toEqual({ a: 2 });
  });
});

test.describe("Extras — nombre au choix (2 paniers…)", () => {
  test("quantité = quantité du séjour × nombre choisi, pour chaque unité", () => {
    expect(extraQuantity("per_stay", 3, 2, 2)).toBe(2);
    expect(extraQuantity("per_night", 3, 2, 2)).toBe(6);
    expect(extraQuantity("per_guest", 3, 2, 2)).toBe(4);
    expect(extraQuantity("per_guest_night", 3, 2, 2)).toBe(12);
    const panier = priceExtraLine({ sourceId: null, label: "Panier", unit: "per_stay", unitPrice: 14.9 }, 5, 4, 3);
    expect(panier).toMatchObject({ chosen: 3, quantity: 3, total: 44.7 });
    // Sans nombre : comme avant (1 par défaut).
    expect(priceExtraLine({ sourceId: null, label: "x", unit: "per_night", unitPrice: 5 }, 3, 2).chosen).toBe(1);
  });

  test("maximum : celui de l'option (absent, 0 ou 1 → 1, plafonné à 99) ; « par lit » → lits de la chambre", () => {
    expect(chosenMax({ unit: "per_stay", maxQuantity: 4 }, 3)).toBe(4);
    expect(chosenMax({ unit: "per_stay", maxQuantity: null }, 3)).toBe(1);
    expect(chosenMax({ unit: "per_stay" }, 3)).toBe(1);
    expect(chosenMax({ unit: "per_night", maxQuantity: 0 }, 3)).toBe(1);
    expect(chosenMax({ unit: "per_night", maxQuantity: 500 }, 3)).toBe(99);
    expect(chosenMax({ unit: "per_bed", maxQuantity: 10 }, 3)).toBe(3);
  });

  test("par défaut : 1, sauf « par lit » (tous les lits) ; borne et valeur de repli", () => {
    expect(defaultChosen("per_stay", 4)).toBe(1);
    expect(defaultChosen("per_bed", 4)).toBe(4);
    expect(clampQuantity(undefined, 4, 1)).toBe(1);
    expect(clampQuantity(undefined, 4, 9)).toBe(4);
    expect(clampQuantity(7, 4, 1)).toBe(4);
  });

  test("saisie de l'hôte : vide ou 1 → pas de choix ; 2 à 99 ; 0, 100, 2,5, texte refusés ; un frais n'a pas de maximum", () => {
    const base = { label: "Panier", price: "12", unit: "per_stay" };
    const max = (v: unknown) => extraSchema.safeParse({ ...base, maxQuantity: v });
    expect(max("").data?.maxQuantity).toBeNull();
    expect(max(undefined).data?.maxQuantity).toBeNull();
    expect(max("1").data?.maxQuantity).toBeNull();
    expect(max("4").data?.maxQuantity).toBe(4);
    expect(max("99").data?.maxQuantity).toBe(99);
    expect(max("0").error?.issues[0].message).toBe("Quantité maximum : au moins 1");
    expect(max("100").error?.issues[0].message).toBe("Quantité maximum : 99 au plus");
    expect(max("2.5").error?.issues[0].message).toBe("Quantité maximum : un nombre entier");
    expect(max("abc").error?.issues[0].message).toBe("Quantité maximum : un nombre entier");
    expect(feeSchema.safeParse({ ...base, maxQuantity: "4" }).data).not.toHaveProperty("maxQuantity");
  });
});
