import { test, expect } from "@playwright/test";
import {
  DEFAULT_REMINDER_DAYS,
  emailVariables,
  fillTemplate,
  reminderDays,
  reminderDue,
} from "../../lib/email-template";

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

const vars = emailVariables({
  guestName: "Marie Curie",
  guestFirstName: "Marie",
  roomName: "Suite Lavande",
  checkIn: d("2027-07-01"),
  checkOut: d("2027-07-04"),
  nights: 3,
  guestCount: 4,
  roomCapacity: 6,
  roomBeds: 3,
  hotelName: "Le Mas",
});

test.describe("Emails — variables des messages", () => {
  test("toutes les variables sont remplacées", () => {
    expect(
      fillTemplate("{client} · {chambre} · {arrivee} → {depart} · {nuits} n · {voyageurs}/{capacite} · {lits} lits · {etablissement}", vars),
    ).toBe("Marie Curie · Suite Lavande · 1 juillet 2027 → 4 juillet 2027 · 3 n · 4/6 · 3 lits · Le Mas");
  });

  test("accents et majuscules tolérés : {Arrivée}, {CLIENT}", () => {
    expect(fillTemplate("{Arrivée} {CLIENT}", vars)).toBe("1 juillet 2027 Marie Curie");
  });

  test("variable inconnue laissée telle quelle, accolades isolées intactes", () => {
    expect(fillTemplate("{inconnue} { client } {}", vars)).toBe("{inconnue} { client } {}");
  });

  test("{prenom} : le prénom ; sans prénom (saisie admin) → le nom complet", () => {
    expect(fillTemplate("Bonjour {prenom}", vars)).toBe("Bonjour Marie");
    const v = emailVariables({ guestName: "Dupont", guestFirstName: "", roomName: "B", checkIn: d("2027-01-01"), checkOut: d("2027-01-02"), nights: 1, hotelName: "H" });
    expect(fillTemplate("Bonjour {Prénom}", v)).toBe("Bonjour Dupont");
  });

  test("lits non renseignés → vide (pas « null »)", () => {
    const v = emailVariables({ guestName: "A", roomName: "B", checkIn: d("2027-01-01"), checkOut: d("2027-01-02"), nights: 1, hotelName: "H", roomBeds: null });
    expect(fillTemplate("[{lits}]", v)).toBe("[]");
  });

  test("le remplacement n'échappe pas : l'échappement HTML se fait après (email.ts)", () => {
    const v = { ...vars, client: "<b>x</b>" };
    expect(fillTemplate("{client}", v)).toBe("<b>x</b>");
  });
});

test.describe("Emails — rappel avant l'arrivée", () => {
  const today = d("2027-03-01");

  test("délai : absent → 2 ; 0 → désactivé ; hors bornes → 2", () => {
    expect(reminderDays({})).toBe(DEFAULT_REMINDER_DAYS);
    expect(reminderDays({ reminderDaysBefore: 7 })).toBe(7);
    expect(reminderDays({ reminderDaysBefore: 0 })).toBe(0);
    expect(reminderDays({ reminderDaysBefore: 31 })).toBe(DEFAULT_REMINDER_DAYS);
    expect(reminderDays({ reminderDaysBefore: 2.5 })).toBe(DEFAULT_REMINDER_DAYS);
  });

  test("J-7 : part à J-7, et rattrape J-6 si le cron a manqué un jour", () => {
    const old = d("2027-01-01");
    expect(reminderDue({ checkIn: d("2027-03-08"), createdAt: old }, today, 7)).toBe(true);
    expect(reminderDue({ checkIn: d("2027-03-07"), createdAt: old }, today, 7)).toBe(true);
    expect(reminderDue({ checkIn: d("2027-03-09"), createdAt: old }, today, 7)).toBe(false);
  });

  test("arrivée aujourd'hui ou passée : pas de rappel", () => {
    const old = d("2027-01-01");
    expect(reminderDue({ checkIn: today, createdAt: old }, today, 7)).toBe(false);
    expect(reminderDue({ checkIn: d("2027-02-27"), createdAt: old }, today, 7)).toBe(false);
  });

  test("réservation prise après le moment du rappel : pas de « rappel » juste après la confirmation", () => {
    expect(reminderDue({ checkIn: d("2027-03-04"), createdAt: d("2027-02-28") }, today, 7)).toBe(false);
    expect(reminderDue({ checkIn: d("2027-03-08"), createdAt: d("2027-03-01") }, today, 7)).toBe(true);
  });

  test("désactivé (0) : jamais", () => {
    expect(reminderDue({ checkIn: d("2027-03-02"), createdAt: d("2026-01-01") }, today, 0)).toBe(false);
  });
});
