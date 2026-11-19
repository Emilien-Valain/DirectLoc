import { test, expect } from "@playwright/test";
import { bookingManualSchema, bookingPublicSchema } from "../../lib/validation";
import { parisToday } from "../../lib/date-windows";

/**
 * Site public : prénom, nom, téléphone et adresse obligatoires ; la saisie manuelle
 * (admin) garde un nom unique et un téléphone facultatif.
 */

const tomorrow = new Date(Date.parse(parisToday() + "T00:00:00Z") + 86_400_000).toISOString().slice(0, 10);
const after = new Date(Date.parse(tomorrow + "T00:00:00Z") + 86_400_000).toISOString().slice(0, 10);
const ok = {
  roomId: "00000000-0000-4000-8000-000000000000",
  checkIn: tomorrow,
  checkOut: after,
  guestFirstName: "Marie",
  guestLastName: "Curie",
  guestEmail: "m@example.com",
  guestPhone: "+33 6 01 02 03 04",
  guestAddress: "12 rue des Lilas, 84000 Avignon",
  guestCount: "1",
};
const messages = (input: Record<string, unknown>) => {
  const r = bookingPublicSchema.safeParse(input);
  return r.success ? [] : r.error.issues.map((i) => i.message);
};

test.describe("Public — coordonnées du client", () => {
  test("saisie complète acceptée ; espaces autour retirés", () => {
    const r = bookingPublicSchema.safeParse({ ...ok, guestFirstName: "  Marie ", guestAddress: " 12 rue des Lilas, 84000 Avignon " });
    expect(r.success).toBe(true);
    expect(r.data?.guestFirstName).toBe("Marie");
    expect(r.data?.guestAddress).toBe("12 rue des Lilas, 84000 Avignon");
  });

  test("champs manquants ou vides (espaces seuls) → message par champ", () => {
    expect(messages({ ...ok, guestFirstName: "   " })).toContain("Prénom obligatoire");
    expect(messages({ ...ok, guestLastName: "" })).toContain("Nom obligatoire");
    expect(messages({ ...ok, guestPhone: "" })).toContain("Téléphone obligatoire");
    expect(messages({ ...ok, guestAddress: "" })).toContain("Adresse obligatoire (rue, code postal, ville)");
    const { guestPhone: _p, guestAddress: _a, ...missing } = ok;
    expect(messages(missing).length).toBeGreaterThanOrEqual(2);
  });

  test("téléphone : lettres refusées, moins de 6 chiffres refusé, 30 caractères max", () => {
    expect(messages({ ...ok, guestPhone: "06 AB CD" })).toContain("Numéro de téléphone invalide");
    expect(messages({ ...ok, guestPhone: "12-34" })).toContain("Numéro de téléphone incomplet");
    expect(messages({ ...ok, guestPhone: "123456" })).toEqual([]);
    expect(messages({ ...ok, guestPhone: "1".repeat(31) })).toContain("Numéro trop long");
  });

  test("limites : nom 100 caractères accepté, 101 refusé ; adresse 300 acceptée, 301 refusée, 4 refusée", () => {
    expect(messages({ ...ok, guestLastName: "a".repeat(100) })).toEqual([]);
    expect(messages({ ...ok, guestLastName: "a".repeat(101) })).toContain("Nom : 100 caractères max");
    expect(messages({ ...ok, guestAddress: "a".repeat(300) })).toEqual([]);
    expect(messages({ ...ok, guestAddress: "a".repeat(301) })).toContain("Adresse trop longue (300 caractères max)");
    expect(messages({ ...ok, guestAddress: "abcd" })).toContain("Adresse obligatoire (rue, code postal, ville)");
  });

  test("saisie manuelle inchangée : nom unique, téléphone et adresse facultatifs", () => {
    const r = bookingManualSchema.safeParse({
      roomId: ok.roomId,
      checkIn: tomorrow,
      checkOut: after,
      guestName: "Marie Curie",
      guestEmail: "m@example.com",
      guestCount: "1",
    });
    expect(r.success).toBe(true);
  });
});
