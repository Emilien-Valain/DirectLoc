import { test, expect } from "@playwright/test";
import fs from "fs";
import path from "path";
import { deleteBookingsByEmail, deleteRoomsByName, getRoomsByName, insertBookings } from "../helpers/intake";
import { todayStart } from "../../lib/date-windows";

/**
 * Spécification : Tests de non-régression > Admin > États vides
 *
 * Un hôte qui démarre voit des listes vides : chacune doit dire ce qui apparaîtra,
 * donner un exemple concret et proposer la première action. On se connecte au
 * tenant « empty-tenant » (créé vide par global-setup, l'admin de test y a accès).
 */

const ctx = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "e2e", ".auth", "test-context.json"), "utf-8"),
) as { emptyTenantSlug: string; emptyTenantId: string };

// Session propre au sous-domaine du tenant vide (les cookies localhost ne s'y appliquent pas) :
// une seule connexion pour tout le fichier, réutilisée par chaque test.
const STATE = path.join(process.cwd(), "e2e", ".auth", "empty-tenant.json");
test.use({ storageState: STATE });

let ORIGIN = "";

test.describe("Admin — États vides", () => {
  test.beforeAll(async ({ browser, baseURL }) => {
    // Premier accès au sous-domaine : compilation de /login à froid, plus lente sous charge.
    test.setTimeout(90_000);
    ORIGIN = baseURL!.replace("localhost", `${ctx.emptyTenantSlug}.localhost`);
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/login`);
    await page.fill('[name="email"]', process.env.TEST_ADMIN_EMAIL!);
    await page.fill('[name="password"]', process.env.TEST_ADMIN_PASSWORD!);
    await page.click('[type="submit"]');
    await page.waitForURL(/\/admin/, { timeout: 30_000 });
    await context.storageState({ path: STATE });
    await context.close();
  });

  test("chambres : explication, exemple et bouton de création", async ({ page }) => {
    await page.goto(`${ORIGIN}/admin/chambres`);
    const empty = page.locator("[data-empty-state]");
    await expect(empty.getByText("Aucune chambre pour l’instant")).toBeVisible();
    await expect(empty.getByText("Exemple :")).toBeVisible();
    await empty.getByRole("link", { name: "Créer ma première chambre" }).click();
    await expect(page).toHaveURL(/\/admin\/chambres\/new$/);
  });

  test("réservations : vide ≠ filtré", async ({ page }) => {
    await page.goto(`${ORIGIN}/admin/reservations`);
    const empty = page.locator("[data-empty-state]");
    await expect(empty.getByText("Aucune réservation pour l’instant")).toBeVisible();
    await expect(empty.getByRole("link", { name: "Saisir une réservation" })).toHaveAttribute(
      "href",
      "/admin/reservations/new",
    );

    await page.goto(`${ORIGIN}/admin/reservations?status=cancelled`);
    await expect(empty.getByText("Aucune réservation ne correspond à ce filtre")).toBeVisible();
    await empty.getByRole("link", { name: "Voir toutes les réservations" }).click();
    await expect(page).toHaveURL(/\/admin\/reservations$/);
  });

  test("calendrier sans chambre active : renvoie vers les chambres", async ({ page }) => {
    await page.goto(`${ORIGIN}/admin/calendrier`);
    const empty = page.locator("[data-empty-state]");
    await expect(empty.getByText("Aucune chambre active")).toBeVisible();
    await empty.getByRole("link", { name: "Voir les chambres" }).click();
    await expect(page).toHaveURL(/\/admin\/chambres$/);
  });

  test("règles : chaque onglet vide explique avec un exemple, « Ajouter » ouvre le formulaire", async ({ page }) => {
    await page.goto(`${ORIGIN}/admin/regles`);
    for (const [tab, title, field] of [
      ["Règles de réservation", "Aucune règle configurée", "minStay"],
      ["Tarification", "Aucune règle tarifaire configurée", "fixedPrice"],
      ["Blocages manuels", "Aucun blocage configuré", "startDate"],
    ] as const) {
      await page.getByRole("tab", { name: tab }).click();
      const empty = page.locator("[data-empty-state]");
      await expect(empty.getByText(title)).toBeVisible();
      await expect(empty.getByText("Exemple :")).toBeVisible();
      // Une seule entrée : le bouton « Ajouter » de l'en-tête, pas de doublon dans l'état vide.
      await expect(empty.getByRole("button")).toHaveCount(0);
      await page.getByRole("button", { name: "Ajouter", exact: true }).click();
      await expect(page.locator(`[name="${field}"]`)).toBeVisible();
      // Formulaire ouvert : l'état vide s'efface (une chose à la fois).
      await expect(page.locator("[data-empty-state]")).toHaveCount(0);
      await page.getByRole("button", { name: "Annuler", exact: true }).first().click();
    }
  });

  test("iCal : explique Airbnb/Booking, « Ajouter » ouvre le formulaire", async ({ page }) => {
    await page.goto(`${ORIGIN}/admin/parametres`);
    await page.getByRole("tab", { name: "Calendriers et paiements" }).click();
    const empty = page.locator("[data-empty-state]");
    await expect(empty.getByText("Aucun calendrier externe configuré")).toBeVisible();
    await page.getByRole("button", { name: "Ajouter", exact: true }).click();
    await expect(page.locator('[name="url"]')).toBeVisible();
    await expect(page.locator("[data-empty-state]")).toHaveCount(0);
  });

  // ─── Dashboard : checklist de mise en route ──────────────────────────────────

  test("dashboard sans chambre : la checklist remplace les KPI à zéro", async ({ page }) => {
    await page.goto(`${ORIGIN}/admin`);
    const setup = page.locator("[data-setup-checklist]");
    await expect(setup.getByRole("heading", { name: "Mettez votre site en route" })).toBeVisible();
    // Plus de « 0 chambre sur 0 » ni de KPI vides pour accueillir un nouvel hôte
    await expect(page.getByText("Occupation ce soir")).toHaveCount(0);
    await expect(page.getByText(/chambres? sur 0/)).toHaveCount(0);
    // Une seule action principale : sans chambre, « Nouvelle réservation » n'a pas de sens
    await expect(page.getByRole("link", { name: "Nouvelle réservation" })).toHaveCount(0);
    // Étapes 2 et 3 verrouillées tant qu'aucune chambre n'existe
    await expect(setup.getByText("Possible dès que votre première chambre existe.")).toHaveCount(3);
    await expect(setup.getByText("Publiez vos conditions d'annulation et documents légaux")).toBeVisible();
    await expect(setup.getByRole("link")).toHaveCount(1);
    await expect(setup.locator('[aria-current="step"]')).toContainText("Ajoutez votre première chambre");
    await setup.getByRole("link", { name: "Ajouter une chambre" }).click();
    await expect(page).toHaveURL(/\/admin\/chambres\/new$/);
  });

  test("dashboard avec une chambre mais sans dates : étape 1 faite, iCal devient l'étape courante", async ({ page }) => {
    const ROOM = `Checklist ${Date.now().toString(36).slice(-6)}`;
    try {
      await page.goto(`${ORIGIN}/admin/chambres/new`);
      await page.fill('[name="nom"]', ROOM);
      await page.fill('[name="prix"]', "90");
      await page.fill('[name="capacite"]', "2");
      await page.click('[type="submit"]');
      await expect(page).toHaveURL(/\/admin\/chambres$/);

      await page.goto(`${ORIGIN}/admin`);
      const setup = page.locator("[data-setup-checklist]");
      await expect(setup.getByText("Fait", { exact: true })).toHaveCount(1);
      await expect(setup.locator('[aria-current="step"]')).toContainText("Synchronisez vos calendriers");
      await expect(setup.getByRole("link", { name: "Ajouter un calendrier" })).toHaveAttribute(
        "href",
        "/admin/parametres?tab=calendriers",
      );
      // Le site s'ouvre dans un nouvel onglet, sur le domaine du tenant
      const site = setup.getByRole("link", { name: "Ouvrir mon site" });
      await expect(site).toHaveAttribute("href", "/");
      await expect(site).toHaveAttribute("target", "_blank");
      // Documents légaux : étape à part, vers l'onglet Documents légaux
      await expect(setup.getByRole("link", { name: "Préparer mes documents" })).toHaveAttribute(
        "href",
        "/admin/parametres?tab=documents",
      );
      // Une chambre existe : on peut de nouveau saisir une réservation
      await expect(page.getByRole("link", { name: "Nouvelle réservation" })).toBeVisible();
    } finally {
      await deleteRoomsByName(ctx.emptyTenantId, ROOM);
    }
  });

  test("site en service sans iCal : rappel Airbnb/Booking, masquable sur cet appareil", async ({ page }) => {
    const RUN = Date.now().toString(36).slice(-6);
    const ROOM = `Rappel ${RUN}`;
    const EMAIL = `nudge-${RUN}@example.com`;
    try {
      await page.goto(`${ORIGIN}/admin/chambres/new`);
      await page.fill('[name="nom"]', ROOM);
      await page.fill('[name="prix"]', "90");
      await page.fill('[name="capacite"]', "2");
      await page.click('[type="submit"]');
      await expect(page).toHaveURL(/\/admin\/chambres$/);
      const [room] = await getRoomsByName(ctx.emptyTenantId, ROOM);
      const checkIn = todayStart();
      checkIn.setUTCDate(checkIn.getUTCDate() + 10);
      const checkOut = new Date(checkIn);
      checkOut.setUTCDate(checkOut.getUTCDate() + 2);
      await insertBookings([
        { tenantId: ctx.emptyTenantId, roomId: room.id, guestName: "Client Rappel", guestEmail: EMAIL, checkIn, checkOut, status: "confirmed" },
      ]);

      // Chambre + réservation : le site tourne, la checklist laisse place au tableau de bord…
      await page.goto(`${ORIGIN}/admin`);
      await expect(page.locator("[data-setup-checklist]")).toHaveCount(0);
      await expect(page.getByText("Occupation ce soir")).toBeVisible();
      // …et tant que les documents légaux ne sont pas publiés, un rappel le dit
      await expect(page.locator("[data-legal-nudge]").getByRole("link", { name: "Préparer mes documents" })).toHaveAttribute(
        "href",
        "/admin/parametres?tab=documents",
      );
      // …mais sans calendrier iCal, le risque de double réservation reste signalé
      const nudge = page.locator("[data-ical-nudge]");
      await expect(nudge.getByRole("heading", { name: "Vous êtes aussi sur Airbnb ou Booking ?" })).toBeVisible();
      await expect(nudge.getByRole("link", { name: "Synchroniser mes calendriers" })).toHaveAttribute(
        "href",
        "/admin/parametres?tab=calendriers",
      );

      await nudge.getByRole("button", { name: "Je ne suis pas sur ces plateformes" }).click();
      await expect(page.locator("[data-ical-nudge]")).toHaveCount(0);
      // Le choix tient au rechargement
      await page.reload();
      await expect(page.getByText("Occupation ce soir")).toBeVisible();
      await expect(page.locator("[data-ical-nudge]")).toHaveCount(0);
    } finally {
      await deleteBookingsByEmail(ctx.emptyTenantId, EMAIL);
      await deleteRoomsByName(ctx.emptyTenantId, ROOM);
    }
  });
});
