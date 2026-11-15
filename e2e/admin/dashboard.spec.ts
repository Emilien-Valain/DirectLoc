import { test, expect } from "@playwright/test";
import fs from "fs";
import path from "path";
import {
  deleteBookingsByEmail,
  deleteRoomsByNameFragment,
  insertBookings,
  insertHiddenRoom,
} from "../helpers/intake";
import { todayStart } from "../../lib/date-windows";

/**
 * Spécification : Tests de non-régression > Admin > Dashboard
 * Référence Obsidian : Phase 2 — Admin (dashboard refonte)
 *
 * Le bloc « Aujourd'hui » répond à la question du matin : qui arrive, qui part.
 * Avant la critique du 2026-10-21, « Départs auj. » comptait en fait les 8 prochains départs.
 */

const ctx = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "e2e", ".auth", "test-context.json"), "utf-8"),
) as { tenantId: string };

const RUN_ID = Date.now().toString(36).slice(-6);
const EMAIL = "dashboard-today@example.com";
const ROOM = `Dashboard ${RUN_ID}`;
const ARRIVING = `Arrivée Jour ${RUN_ID}`;
const LEAVING = `Départ Jour ${RUN_ID}`;
const TOMORROW = `Arrivée Demain ${RUN_ID}`;
const CANCELLED = `Annulée Jour ${RUN_ID}`;
const PENDING = `Attente Jour ${RUN_ID}`;
const PENDING_PAST = `Attente Passée ${RUN_ID}`;
const PENDING_FAR = `Attente Loin ${RUN_ID}`;
const WEEK_END = `Fin Semaine ${RUN_ID}`;
const BEYOND = `Au Delà ${RUN_ID}`;
const PENDING_LEAVING = `Attente Part ${RUN_ID}`;
const PENDING_DONE = `Attente Finie ${RUN_ID}`;
const TO_CONFIRM = `À Confirmer ${RUN_ID}`;
const STAYING = `Reste Ce Soir ${RUN_ID}`;
const iso = (d: Date) => d.toISOString().slice(0, 10);

// Jour relatif à « aujourd'hui » à Paris (même définition que le dashboard), en UTC minuit.
function utcDay(offset: number) {
  const d = todayStart();
  d.setUTCDate(d.getUTCDate() + offset);
  return d;
}

test.describe("Admin — Dashboard", () => {
  test.beforeAll(async () => {
    await deleteBookingsByEmail(ctx.tenantId, EMAIL);
    const roomId = await insertHiddenRoom(ctx.tenantId, ROOM);
    const base = { tenantId: ctx.tenantId, roomId, guestEmail: EMAIL };
    await insertBookings([
      { ...base, guestName: ARRIVING, checkIn: utcDay(0), checkOut: utcDay(2), status: "confirmed" },
      { ...base, guestName: LEAVING, checkIn: utcDay(-2), checkOut: utcDay(0), status: "confirmed" },
      { ...base, guestName: TOMORROW, checkIn: utcDay(1), checkOut: utcDay(3), status: "pending" },
      { ...base, guestName: CANCELLED, checkIn: utcDay(0), checkOut: utcDay(1), status: "cancelled" },
      { ...base, guestName: PENDING, checkIn: utcDay(0), checkOut: utcDay(1), status: "pending", guestPhone: "06 12 34 56 78" },
      // Non confirmée, arrivée passée : un webhook manqué ou un oubli, à traiter quand même
      { ...base, guestName: PENDING_PAST, checkIn: utcDay(-2), checkOut: utcDay(9), status: "pending" },
      // Non confirmée mais dans 3 jours : pas encore urgente
      { ...base, guestName: PENDING_FAR, checkIn: utcDay(3), checkOut: utcDay(10), status: "pending" },
      // Bornes de la semaine : J+7 dedans, J+8 dehors
      { ...base, guestName: WEEK_END, checkIn: utcDay(7), checkOut: utcDay(12), status: "confirmed" },
      { ...base, guestName: BEYOND, checkIn: utcDay(8), checkOut: utcDay(12), status: "confirmed" },
      { ...base, guestName: PENDING_LEAVING, checkIn: utcDay(-1), checkOut: utcDay(0), status: "pending" },
      { ...base, guestName: PENDING_DONE, checkIn: utcDay(-5), checkOut: utcDay(-3), status: "pending" },
      { ...base, guestName: TO_CONFIRM, checkIn: utcDay(2), checkOut: utcDay(4), status: "pending" },
      { ...base, guestName: STAYING, checkIn: utcDay(-1), checkOut: utcDay(1), status: "confirmed" },
    ]);
  });

  test.afterAll(async () => {
    await deleteBookingsByEmail(ctx.tenantId, EMAIL);
    await deleteRoomsByNameFragment(ctx.tenantId, RUN_ID);
  });

  // ─── Happy path ────────────────────────────────────────────────────────────

  test("le dashboard affiche le titre et les KPIs", async ({ page }) => {
    await page.goto("/admin");
    await expect(page.getByRole("heading", { level: 1, name: /bonjour/i })).toBeVisible();
    await expect(page.getByText("Occupation ce soir")).toBeVisible();
    await expect(page.getByText("Réservé ce mois")).toBeVisible();
    await expect(page.getByText("Réservations ce mois", { exact: true })).toBeVisible();
    // Un seul chiffre d'affaires : plus de CA jour / semaine concurrents
    await expect(page.getByText(/^CA /)).toHaveCount(0);
    // Tenant en service (chambres + réservations) : pas de checklist de mise en route
    await expect(page.locator("[data-setup-checklist]")).toHaveCount(0);
    // …ni de rappel iCal : test-tenant a un calendrier synchronisé
    await expect(page.locator("[data-ical-nudge]")).toHaveCount(0);
  });

  test("« Aujourd'hui » nomme les arrivées et départs du jour, et seulement eux", async ({ page }) => {
    await page.goto("/admin");
    const arrivals = page.getByRole("region", { name: "Arrivées" });
    const departures = page.getByRole("region", { name: "Départs" });

    await expect(arrivals.getByText(ARRIVING)).toBeVisible();
    await expect(arrivals.getByText(TOMORROW)).toHaveCount(0);
    await expect(arrivals.getByText(CANCELLED)).toHaveCount(0);
    await expect(arrivals.getByText(LEAVING)).toHaveCount(0);

    const leaving = departures.getByRole("link", { name: new RegExp(LEAVING) });
    await expect(leaving).toBeVisible();
    await expect(leaving).toContainText("Chambre à préparer");
    await expect(departures.getByText(ARRIVING)).toHaveCount(0);

    // Le compteur annoncé = le nombre de personnes listées (régression « Départs auj. »)
    for (const region of [arrivals, departures]) {
      const n = await region.getByRole("listitem").count();
      await expect(region.getByRole("heading")).toContainText(`· ${n}`);
    }

    await leaving.click();
    await expect(page).toHaveURL(/\/admin\/reservations\/[0-9a-f-]{36}$/);
  });

  test("« Aujourd'hui » signale le séjour non confirmé et permet d'appeler le client", async ({ page }) => {
    await page.goto("/admin");
    const arrivals = page.getByRole("region", { name: "Arrivées" });
    const pending = arrivals.getByRole("listitem").filter({ hasText: PENDING });
    const confirmed = arrivals.getByRole("listitem").filter({ hasText: ARRIVING });
    await expect(pending.getByText("En attente")).toBeVisible();
    // Une arrivée confirmée n'a pas de badge : seul l'inhabituel attire l'œil
    await expect(confirmed.getByText(/En attente|Confirmée/)).toHaveCount(0);
    const call = pending.getByRole("link", { name: `Appeler ${PENDING} au 06 12 34 56 78` });
    await expect(call).toHaveAttribute("href", "tel:0612345678");
    // Sans numéro, pas de bouton d'appel vide
    await expect(confirmed.getByRole("link", { name: /^Appeler/ })).toHaveCount(0);
  });

  test("« À traiter » : les non confirmées qui arrivent d'ici après-demain, passées comprises", async ({ page }) => {
    await page.goto("/admin");
    const todo = page.locator("[data-to-handle]");
    await expect(todo.getByRole("heading", { name: /À traiter · \d+/ })).toBeVisible();
    await expect(todo.getByRole("listitem").filter({ hasText: PENDING })).toContainText("arrivée aujourd'hui");
    await expect(todo.getByRole("listitem").filter({ hasText: TOMORROW })).toContainText("arrivée");
    // Le passé dit ce qui s'est passé, jamais « prévu »
    await expect(todo.getByRole("listitem").filter({ hasText: PENDING_PAST })).toContainText(/séjour commencé le .+, toujours non confirmé/);
    await expect(todo.getByRole("listitem").filter({ hasText: PENDING_LEAVING })).toContainText("départ aujourd'hui, toujours non confirmé");
    await expect(todo.getByRole("listitem").filter({ hasText: PENDING_DONE })).toContainText(/séjour terminé le .+, jamais confirmé/);
    await expect(todo.getByText(/prévue/)).toHaveCount(0);
    // Les retards passent en tête de file
    await expect(todo.getByRole("listitem").first()).toContainText(PENDING_DONE);
    // Pas dans la file : une confirmée, ou une non confirmée encore lointaine
    await expect(todo.getByText(ARRIVING)).toHaveCount(0);
    await expect(todo.getByText(PENDING_FAR)).toHaveCount(0);
    // La section dit déjà « non confirmée » : pas de badge répété sur chaque ligne
    await expect(todo.getByText("En attente")).toHaveCount(0);
  });

  test("« À traiter » : « Confirmer » en un geste, la ligne quitte la file", async ({ page }) => {
    await page.goto("/admin");
    const todo = page.locator("[data-to-handle]");
    await todo.getByRole("button", { name: `Confirmer la réservation de ${TO_CONFIRM}` }).click();
    await expect(todo.getByText(TO_CONFIRM)).toHaveCount(0);
    // Toujours au planning de la semaine, désormais sans badge « En attente »
    // Arrivée à J+2 et départ à J+4 : on lit la ligne d'arrivée
    const row = page.locator("[data-week-plan]").getByRole("listitem").filter({ hasText: TO_CONFIRM }).filter({ hasText: "Arrivée" });
    await expect(row).toBeVisible();
    await expect(row.getByText("En attente")).toHaveCount(0);
  });

  test("« Restent ce soir » : les clients déjà là qui dorment encore ici, avec leur départ", async ({ page }) => {
    await page.goto("/admin");
    const staying = page.getByRole("region", { name: "Restent ce soir" });
    await expect(staying.getByRole("listitem").filter({ hasText: STAYING })).toContainText("part demain");
    await expect(staying.getByRole("listitem").filter({ hasText: PENDING_PAST })).toContainText("part ");
    // Ni les arrivées du jour (déjà listées), ni ceux qui partent aujourd'hui, ni les séjours finis
    for (const name of [ARRIVING, LEAVING, PENDING_LEAVING, PENDING_DONE]) {
      await expect(staying.getByText(name)).toHaveCount(0);
    }
  });

  test("« 7 prochains jours » : jour par jour, de demain à J+7, arrivées et départs", async ({ page }) => {
    await page.goto("/admin");
    const week = page.locator("[data-week-plan]");
    const tomorrow = week.locator(`[data-day="${iso(utcDay(1))}"]`);
    await expect(tomorrow.getByRole("heading", { level: 3 })).toContainText(/^Demain, /);
    await expect(tomorrow.getByRole("listitem").filter({ hasText: TOMORROW })).toContainText("Arrivée · 2 nuits · 1 pers.");
    // ARRIVING arrive aujourd'hui (bloc « Aujourd'hui ») et repart à J+2 : il apparaît comme départ
    const dayTwo = week.locator(`[data-day="${iso(utcDay(2))}"]`);
    await expect(dayTwo.getByRole("listitem").filter({ hasText: ARRIVING })).toContainText("Départ · chambre à préparer");
    await expect(week.getByRole("listitem").filter({ hasText: ARRIVING })).toHaveCount(1);
    // Bornes
    await expect(week.locator(`[data-day="${iso(utcDay(7))}"]`).getByText(WEEK_END)).toBeVisible();
    await expect(week.getByText(BEYOND)).toHaveCount(0);
    // Les annulées n'apparaissent nulle part
    await expect(week.getByText(CANCELLED)).toHaveCount(0);
  });

  test("les chiffres du mois restent en marge, avec la répartition par canal", async ({ page }) => {
    await page.goto("/admin");
    const figures = page.locator("[data-month-figures]");
    await expect(figures.getByText("Occupation ce soir")).toBeVisible();
    await expect(figures.getByText(/^\d+ %$/)).toBeVisible();
    await expect(figures.getByText("Réservations par canal")).toBeVisible();
  });

  test("plus de cartes raccourcis (doublons du menu) ; « Nouvelle réservation » reste en tête", async ({ page }) => {
    await page.goto("/admin");
    await expect(page.getByText("Gérer le catalogue")).toHaveCount(0);
    await expect(page.getByText("Vue mensuelle")).toHaveCount(0);
    await expect(page.getByRole("link", { name: /nouvelle réservation/i })).toBeVisible();
  });

  // Note : l'accès non authentifié à /admin est testé dans e2e/auth/login.spec.ts
});
