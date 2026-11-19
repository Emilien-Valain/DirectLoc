import { test, expect } from "@playwright/test";
import {
  balanceDue,
  bedLimit,
  chosenLabel,
  chosenMax,
  extraQuantitiesFrom,
  extraQuantity,
  grandTotal,
  priceExtraLine,
  resolveChosen,
} from "../../lib/extras";
import { extraSchema, feeSchema } from "../../lib/validation";

/**
 * Spécification : Tests de non-régression > Extras > Calcul (ADR-0010)
 * Fonction pure partagée par le récap public, le devis admin et l'admission serveur.
 */

const stay = (nights: number, guests: number, beds = 1) => ({ nights, guests, beds });
const line = (unit: Parameters<typeof extraQuantity>[0], unitPrice: number, nights: number, guests: number) =>
  priceExtraLine({ sourceId: null, label: "x", unit, unitPrice }, stay(nights, guests));

test.describe("Extras — calcul", () => {
  test("quantité dérivée des 4 unités", () => {
    expect(extraQuantity("per_stay", stay(3, 2))).toBe(1);
    expect(extraQuantity("per_night", stay(3, 2))).toBe(3);
    expect(extraQuantity("per_guest", stay(3, 2))).toBe(2);
    expect(extraQuantity("per_guest_night", stay(3, 2))).toBe(6);
  });

  test("limite 1 nuit / 1 personne : quantité 1 pour toutes les unités", () => {
    for (const u of ["per_stay", "per_night", "per_guest", "per_guest_night"] as const) {
      expect(extraQuantity(u, stay(1, 1))).toBe(1);
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

test.describe("Extras — nombre choisi, borné par le séjour", () => {
  const s = stay(5, 4, 3);

  test("maximum selon l'unité : nuits, voyageurs, lits ; par séjour : celui de l'hôte (absent → 1, plafonné à 99)", () => {
    expect(chosenMax({ unit: "per_night" }, s)).toBe(5);
    expect(chosenMax({ unit: "per_guest" }, s)).toBe(4);
    expect(chosenMax({ unit: "per_guest_night" }, s)).toBe(4);
    expect(chosenMax({ unit: "per_bed", maxQuantity: 10 }, s)).toBe(3);
    expect(chosenMax({ unit: "per_stay", maxQuantity: 4 }, s)).toBe(4);
    expect(chosenMax({ unit: "per_stay", maxQuantity: null }, s)).toBe(1);
    expect(chosenMax({ unit: "per_stay", maxQuantity: 500 }, s)).toBe(99);
    // L'hôte ne fixe rien pour les autres unités : son maximum est ignoré.
    expect(chosenMax({ unit: "per_night", maxQuantity: 2 }, s)).toBe(5);
    expect(chosenMax({ unit: "per_night" }, stay(0, 1))).toBe(1);
  });

  test("quantité : le nombre choisi remplace la dimension ; null = tout le séjour", () => {
    expect(extraQuantity("per_night", s, 2)).toBe(2);
    expect(extraQuantity("per_night", s, null)).toBe(5);
    expect(extraQuantity("per_guest", s, 2)).toBe(2);
    expect(extraQuantity("per_guest_night", s, 2)).toBe(10); // 2 personnes × 5 nuits
    expect(extraQuantity("per_guest_night", s, null)).toBe(20);
    expect(extraQuantity("per_bed", s, 1)).toBe(1);
    expect(extraQuantity("per_bed", s, null)).toBe(3);
    expect(extraQuantity("per_stay", s, 3)).toBe(3);
    expect(extraQuantity("per_stay", s, null)).toBe(1);
    const petitDej = priceExtraLine({ sourceId: null, label: "Petit-déj", unit: "per_guest_night", unitPrice: 12.5 }, s, 2);
    expect(petitDej).toMatchObject({ chosen: 2, quantity: 10, total: 125 });
  });

  test("choix retenu : demandé > enregistré > défaut ; borné ; égal au max → null (suit le séjour)", () => {
    expect(resolveChosen("per_night", 5)).toBeNull();
    expect(resolveChosen("per_night", 5, 2)).toBe(2);
    expect(resolveChosen("per_night", 5, 5)).toBeNull();
    expect(resolveChosen("per_night", 5, 99)).toBeNull();
    expect(resolveChosen("per_night", 5, 0)).toBe(1);
    expect(resolveChosen("per_night", 5, -3)).toBe(1);
    expect(resolveChosen("per_night", 5, 2.7)).toBe(2);
    expect(resolveChosen("per_night", 5, NaN, 3)).toBe(3);
    expect(resolveChosen("per_night", 2, undefined, 3)).toBeNull(); // séjour raccourci : borné, donc tout
    expect(resolveChosen("per_stay", 4)).toBe(1);
    expect(resolveChosen("per_stay", 4, 4)).toBe(4); // par séjour : jamais « tout »
    expect(resolveChosen("per_stay", 4, undefined, 2)).toBe(2);
  });

  test("libellés : nuits, personnes, lits ; un nombre seul par séjour", () => {
    expect(chosenLabel("per_night", 1)).toBe("1 nuit");
    expect(chosenLabel("per_night", 3)).toBe("3 nuits");
    expect(chosenLabel("per_guest_night", 2)).toBe("2 personnes");
    expect(chosenLabel("per_bed", 1)).toBe("1 lit");
    expect(chosenLabel("per_stay", 2)).toBe("2");
  });

  test("lits non renseignés → capacité ; jamais moins de 1 ; champs extraQty_ lus, vides ignorés", () => {
    expect(bedLimit({ beds: null, capacity: 6 })).toBe(6);
    expect(bedLimit({ beds: 2, capacity: 6 })).toBe(2);
    expect(bedLimit({ beds: 0, capacity: 6 })).toBe(1);
    expect(extraQuantitiesFrom([["extraQty_a", "2"], ["extraQty_b", ""], ["extraIds", "a"]])).toEqual({ a: 2 });
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
