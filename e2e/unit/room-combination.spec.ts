import { test, expect } from "@playwright/test";
import { distributeGuests, ruleReasons, suggestCombination, validateCombination, type RoomCandidate } from "../../lib/room-combination";
import { noCombinationMessage } from "../../lib/dossier-messages";

const room = (id: string, capacity: number, totalPrice: number, excludedReason?: string): RoomCandidate => ({
  id,
  capacity,
  totalPrice,
  excludedReason,
});
const ids = (r: ReturnType<typeof suggestCombination>) => (r.ok ? r.rooms.map((x) => x.roomId).sort() : null);

const hotel = [room("a", 4, 400), room("b", 3, 300), room("c", 2, 200), room("d", 2, 150)];

test.describe("suggestCombination", () => {
  test("1 personne : une seule chambre, la moins chère", () => {
    const r = suggestCombination(hotel, 1, 0);
    expect(ids(r)).toEqual(["d"]);
    expect(r.ok && r.rooms[0]).toMatchObject({ guests: 1, adults: 1, minors: 0 });
  });

  test("capacité exacte : 4 personnes -> 1 chambre de 4 (moins de chambres avant prix)", () => {
    const r = suggestCombination(hotel, 2, 2);
    expect(ids(r)).toEqual(["a"]);
    expect(r.ok && r.rooms[0]).toMatchObject({ guests: 4, adults: 2, minors: 2 });
  });

  test("9 personnes sur 4+3+2 : 3 chambres pleines, ≥ 1 adulte partout", () => {
    const r = suggestCombination([room("a", 4, 400), room("b", 3, 300), room("c", 2, 200)], 5, 4);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rooms.map((x) => x.guests)).toEqual([4, 3, 2]);
    expect(r.rooms.every((x) => x.adults >= 1)).toBe(true);
    expect(r.rooms.reduce((s, x) => s + x.adults, 0)).toBe(5);
    expect(r.rooms.reduce((s, x) => s + x.minors, 0)).toBe(4);
    expect(r.totalPrice).toBe(900);
  });

  test("égalité de nombre de chambres : la moins chère gagne", () => {
    const r = suggestCombination([room("a", 2, 300), room("b", 2, 100), room("c", 2, 200)], 4, 0);
    expect(ids(r)).toEqual(["b", "c"]);
    expect(r.ok && r.totalPrice).toBe(300);
  });

  test("égalité totale de prix : départage stable, indépendant de l'ordre d'entrée", () => {
    const rooms = [room("x", 2, 100), room("y", 2, 100), room("z", 2, 100)];
    const r1 = suggestCombination(rooms, 4, 0);
    const r2 = suggestCombination([...rooms].reverse(), 4, 0);
    expect(r1).toEqual(r2);
  });

  test("aucune combinaison : capacité max atteignable (chambres exclues ignorées)", () => {
    const r = suggestCombination([room("a", 4, 1), room("b", 3, 1), room("c", 5, 1, "Séjour minimum de 3 nuits")], 8, 0);
    expect(r).toEqual({ ok: false, reason: "insufficient_capacity", maxCapacity: 7 });
  });

  test("chambre refusée par une règle (nuits min) jamais proposée, même moins chère", () => {
    const r = suggestCombination([room("a", 2, 50, "Séjour minimum de 3 nuits"), room("b", 2, 500)], 2, 0);
    expect(ids(r)).toEqual(["b"]);
  });

  test("aucun candidat : capacité max 0", () => {
    expect(suggestCombination([], 1, 0)).toEqual({ ok: false, reason: "insufficient_capacity", maxCapacity: 0 });
  });

  test("2 adultes + 7 mineurs sur 4+3+2 : 3 chambres nécessaires -> not_enough_adults", () => {
    const r = suggestCombination([room("a", 4, 400), room("b", 3, 300), room("c", 2, 200)], 2, 7);
    expect(r).toEqual({ ok: false, reason: "not_enough_adults", maxCapacity: 7 });
  });

  test("3 adultes + 6 mineurs sur 4+3+2 : ok, 1 adulte par chambre", () => {
    const r = suggestCombination([room("a", 4, 400), room("b", 3, 300), room("c", 2, 200)], 3, 6);
    expect(r.ok && r.rooms.map((x) => [x.guests, x.adults, x.minors])).toEqual([[4, 1, 3], [3, 1, 2], [2, 1, 1]]);
  });

  test("capacité insuffisante reste prioritaire sur le manque d'adultes", () => {
    expect(suggestCombination([room("a", 2, 1)], 1, 5)).toMatchObject({ ok: false, reason: "insufficient_capacity" });
  });

  test("0 personne, négatifs, décimaux, 0 adulte : refusés", () => {
    for (const [a, m] of [[0, 0], [-1, 2], [2, -1], [1.5, 0], [Number.NaN, 0], [0, 3]]) {
      expect(suggestCombination(hotel, a, m)).toMatchObject({ ok: false, reason: "invalid_input" });
    }
  });

  test("beaucoup de chambres : borné et rapide", () => {
    const many = Array.from({ length: 60 }, (_, i) => room(`r${String(i).padStart(2, "0")}`, 1 + (i % 5), 100 + i));
    const t = Date.now();
    const r = suggestCombination(many, 40, 20);
    expect(r.ok).toBe(true);
    expect(Date.now() - t).toBeLessThan(2000);
  });
});

test.describe("validateCombination", () => {
  const ok = [
    { roomId: "a", guests: 4, minors: 1 },
    { roomId: "b", guests: 2, minors: 1 },
  ];
  test("combinaison valide", () => {
    expect(validateCombination(hotel, ok, 4, 2)).toEqual({ ok: true, totalPrice: 700, totalCapacity: 7 });
  });
  const codes = (r: ReturnType<typeof validateCombination>) => (r.ok ? [] : r.errors.map((e) => e.code));

  test("chambre au-dessus de sa capacité", () => {
    const r = validateCombination(hotel, [{ roomId: "c", guests: 3, minors: 0 }, { roomId: "a", guests: 3, minors: 0 }], 6, 0);
    expect(codes(r)).toContain("over_capacity");
  });
  test("mineurs > personnes de la chambre", () => {
    const r = validateCombination(hotel, [{ roomId: "a", guests: 2, minors: 3 }, { roomId: "b", guests: 3, minors: 0 }], 2, 3);
    expect(codes(r)).toContain("minors_exceed_guests");
  });
  test("doublon de chambre", () => {
    const r = validateCombination(hotel, [{ roomId: "a", guests: 2, minors: 0 }, { roomId: "a", guests: 2, minors: 0 }], 4, 0);
    expect(codes(r)).toContain("duplicate_room");
  });
  test("chambre inconnue ou exclue par une règle", () => {
    expect(codes(validateCombination(hotel, [{ roomId: "zzz", guests: 2, minors: 0 }], 2, 0))).toContain("unknown_room");
    const ex = [room("a", 2, 1, "min 3 nuits")];
    expect(codes(validateCombination(ex, [{ roomId: "a", guests: 2, minors: 0 }], 2, 0))).toContain("room_excluded");
  });
  test("chambre 100 % mineurs -> no_adult", () => {
    const r = validateCombination(hotel, [{ roomId: "a", guests: 3, minors: 0 }, { roomId: "b", guests: 2, minors: 2 }], 3, 2);
    expect(codes(r)).toEqual(["no_adult"]);
  });
  test("capacité totale insuffisante", () => {
    expect(codes(validateCombination(hotel, [{ roomId: "c", guests: 2, minors: 0 }], 5, 0))).toContain("insufficient_capacity");
  });
  test("répartition incohérente avec les personnes saisies", () => {
    expect(codes(validateCombination(hotel, [{ roomId: "a", guests: 3, minors: 0 }], 4, 0))).toContain("people_mismatch");
    expect(codes(validateCombination(hotel, [{ roomId: "a", guests: 4, minors: 0 }], 2, 2))).toContain("minors_mismatch");
  });
  test("vide, chambre vide, valeurs négatives/0 personne", () => {
    expect(codes(validateCombination(hotel, [], 2, 0))).toEqual(["empty"]);
    expect(codes(validateCombination(hotel, [{ roomId: "a", guests: 0, minors: 0 }, { roomId: "b", guests: 2, minors: 0 }], 2, 0))).toContain("empty_room");
    expect(codes(validateCombination(hotel, [{ roomId: "a", guests: -1, minors: 0 }], 2, 0))).toContain("invalid_count");
    expect(codes(validateCombination(hotel, ok, 0, 0))).toEqual(["invalid_input"]);
    expect(codes(validateCombination(hotel, ok, -2, 3))).toEqual(["invalid_input"]);
  });
});

test.describe("distributeGuests (voyageur qui ajoute / retire / échange une chambre)", () => {
  const caps = [room("c", 2, 0), room("a", 4, 0), room("b", 3, 0)];

  test("ordre reçu conservé, remplissage de la plus grande à la plus petite, 1 adulte par chambre", () => {
    expect(distributeGuests(caps, 7, 2)).toEqual([
      { roomId: "c", guests: 2, adults: 1, minors: 1 },
      { roomId: "a", guests: 4, adults: 4, minors: 0 },
      { roomId: "b", guests: 3, adults: 2, minors: 1 },
    ]);
  });

  test("capacité de trop : la plus petite chambre reste vide (le voyageur la retire)", () => {
    const r = distributeGuests(caps, 4, 1);
    expect(r.find((x) => x.roomId === "c")).toMatchObject({ guests: 0, adults: 0, minors: 0 });
    expect(r.reduce((s, x) => s + x.guests, 0)).toBe(5);
  });

  test("capacité insuffisante : chambres pleines, le reste n'est pas placé (validateCombination le dit)", () => {
    const r = distributeGuests(caps, 10, 2);
    expect(r.map((x) => x.guests)).toEqual([2, 4, 3]);
    const v = validateCombination(caps, r.map(({ roomId, guests, minors }) => ({ roomId, guests, minors })), 10, 2);
    expect(v.ok).toBe(false);
  });

  test("moins d'adultes que de chambres : une chambre sans adulte, refusée par la validation", () => {
    const r = distributeGuests(caps, 2, 7);
    expect(r.filter((x) => x.guests > 0 && x.adults === 0)).toHaveLength(1);
    const v = validateCombination(caps, r.map(({ roomId, guests, minors }) => ({ roomId, guests, minors })), 2, 7);
    expect(!v.ok && v.errors.map((e) => e.code)).toContain("no_adult");
  });

  test("aucune chambre / valeurs négatives : rien n'est placé, jamais d'exception", () => {
    expect(distributeGuests([], 3, 1)).toEqual([]);
    expect(distributeGuests(caps, -1, -4).every((x) => x.guests === 0)).toBe(true);
  });
});

test.describe("règles qui écartent des chambres : la raison est dite au voyageur", () => {
  test("ruleReasons : raisons uniques, chambres sans règle ignorées", () => {
    const c = [room("a", 4, 1, "Séjour minimum de 2 nuits"), room("b", 2, 1, "Séjour minimum de 2 nuits"), room("c", 2, 1)];
    expect(ruleReasons(c)).toEqual(["Séjour minimum de 2 nuits"]);
    expect(ruleReasons([room("c", 2, 1)])).toEqual([]);
  });

  test("toutes les chambres libres écartées : la règle remplace « Complet »", () => {
    const msg = noCombinationMessage("insufficient_capacity", 6, 5, 0, ["Séjour minimum de 2 nuits"]);
    expect(msg).toContain("Séjour minimum de 2 nuits");
    expect(msg).not.toContain("Complet");
    expect(noCombinationMessage("insufficient_capacity", 6, 5, 0)).toContain("Complet");
  });

  test("une partie des chambres écartée : capacité restante + la règle", () => {
    const msg = noCombinationMessage("insufficient_capacity", 6, 5, 4, ["Arrivée autorisée uniquement le samedi"]);
    expect(msg).toContain("4 personnes au plus");
    expect(msg).toContain("Arrivée autorisée uniquement le samedi");
  });
});
