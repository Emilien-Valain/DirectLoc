import { test, expect, type Page } from "@playwright/test";
import fs from "fs";
import path from "path";
import { fd } from "../helpers/dates";
import { confirmDialog } from "../helpers/confirm";
import { cleanRules } from "../helpers/clean-rules";
import { deleteRoomsByName, insertBookingRule, insertHiddenRoom, insertPricingRule } from "../helpers/intake";
import { insertManualBlock } from "../helpers/manual-blocks";
import { Pool } from "pg";

/**
 * Spécification : Tests de non-régression > Règles — modifier une règle,
 * tarification multi-chambres et « une valeur par chambre ».
 * Chambre API : prix de base 100 €. Une seconde chambre (inactive) est créée pour
 * les règles visant plusieurs chambres.
 */

const ctx = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "e2e", ".auth", "test-context.json"), "utf-8"),
) as { tenantId: string; apiRoomId: string };

const SECOND = "Chambre Règles Bis";
const THIRD = "Chambre Règles Ter";
let secondRoomId: string;
let thirdRoomId: string;

/** Pastille d'une chambre dans le sélecteur « Chambres concernées ». */
const pill = (scope: import("@playwright/test").Locator, name: string) =>
  scope.getByTestId("room-picker").getByRole("button", { name, exact: true });

async function blockedDates(page: Page, roomId: string): Promise<string[]> {
  const res = await page.request.get("/api/availability", { params: { roomId, from: fd("2027-05-01"), to: fd("2027-05-05") } });
  expect(res.ok()).toBe(true);
  return (await res.json()).blockedDates;
}

async function minStay(page: Page, roomId: string): Promise<number | null> {
  const res = await page.request.get("/api/rules", { params: { roomId, checkIn: fd("2027-05-01") } });
  return (await res.json()).minStay;
}

test.use({ extraHTTPHeaders: { "x-forwarded-for": "10.10.0.21" } });

async function nightPrice(page: Page, roomId: string): Promise<number> {
  const res = await page.request.get("/api/pricing", {
    params: { roomId, from: fd("2027-03-01"), to: fd("2027-03-02") },
  });
  expect(res.ok()).toBe(true);
  return (await res.json()).nights[0].price as number;
}

async function openTab(page: Page, tab: string) {
  await page.goto("/admin/regles");
  await page.getByRole("tab", { name: tab }).click();
}

test.describe("Règles — modifier et cibler plusieurs chambres", () => {
  test.beforeAll(async () => {
    await cleanRules(ctx.tenantId);
    await deleteRoomsByName(ctx.tenantId, SECOND);
    await deleteRoomsByName(ctx.tenantId, THIRD);
    secondRoomId = await insertHiddenRoom(ctx.tenantId, SECOND);
    thirdRoomId = await insertHiddenRoom(ctx.tenantId, THIRD);
  });
  test.afterEach(async () => {
    await cleanRules(ctx.tenantId);
  });
  test.afterAll(async () => {
    await deleteRoomsByName(ctx.tenantId, SECOND);
    await deleteRoomsByName(ctx.tenantId, THIRD);
  });

  // ─── Modifier : règles de séjour ─────────────────────────────────────────────

  test("modifier une règle de séjour : valeurs pré-remplies, mise à jour sans doublon", async ({ page }) => {
    await openTab(page, "Règles de réservation");
    await page.getByRole("button", { name: "Ajouter" }).click();
    await page.locator("input[name='minStay']").fill("2");
    await page.getByRole("button", { name: "Sam" }).first().click();
    await page.getByRole("button", { name: "Créer la règle" }).click();
    await expect(page.getByText("Min 2 nuit(s)")).toBeVisible();

    await page.getByRole("button", { name: /Modifier la règle/ }).click();
    const form = page.getByTestId("booking-rule-form");
    await expect(form.locator("input[name='minStay']")).toHaveValue("2");
    await expect(form.getByRole("button", { name: "Sam" }).first()).toHaveAttribute("aria-pressed", "true");
    await form.locator("input[name='minStay']").fill("4");
    await form.getByRole("button", { name: "Enregistrer" }).click();

    await expect(page.getByText("Règle de réservation modifiée.")).toBeVisible();
    await expect(page.getByText("Min 4 nuit(s)")).toBeVisible();
    await expect(page.getByText("Arrivée : samedi")).toBeVisible();
    await expect(page.getByTestId("booking-rule-row")).toHaveCount(1);
  });

  test("modifier puis annuler : rien ne change", async ({ page }) => {
    await openTab(page, "Règles de réservation");
    await page.getByRole("button", { name: "Ajouter" }).click();
    await page.locator("input[name='maxStay']").fill("10");
    await page.getByRole("button", { name: "Créer la règle" }).click();
    await expect(page.getByText("Max 10 nuit(s)")).toBeVisible();

    await page.getByRole("button", { name: /Modifier la règle/ }).click();
    await page.getByTestId("booking-rule-form").locator("input[name='maxStay']").fill("3");
    await page.getByTestId("booking-rule-form").getByRole("button", { name: "Annuler" }).click();
    await expect(page.getByText("Max 10 nuit(s)")).toBeVisible();
    await page.reload();
    await page.getByRole("tab", { name: "Règles de réservation" }).click();
    await expect(page.getByText("Max 10 nuit(s)")).toBeVisible();
  });

  test("période inversée refusée (création et modification)", async ({ page }) => {
    await openTab(page, "Règles de réservation");
    await page.getByRole("button", { name: "Ajouter" }).click();
    await page.locator("input[name='validFrom']").fill(fd("2027-08-31"));
    await page.locator("input[name='validTo']").fill(fd("2027-07-01"));
    await page.locator("input[name='minStay']").fill("2");
    await page.getByRole("button", { name: "Créer la règle" }).click();
    await expect(page.getByText("La fin de période doit être après le début").first()).toBeVisible();
    await expect(page.getByTestId("booking-rule-row")).toHaveCount(0);
  });

  // ─── Modifier : blocages ─────────────────────────────────────────────────────

  test("modifier un blocage : dates pré-remplies puis décalées", async ({ page }) => {
    await openTab(page, "Blocages manuels");
    await page.getByRole("button", { name: "Ajouter" }).first().click();
    await page.locator("input[name='startDate']").fill(fd("2027-02-01"));
    await page.locator("input[name='endDate']").fill(fd("2027-02-05"));
    await page.getByRole("button", { name: "Créer le blocage" }).click();
    await expect(page.getByTestId("manual-block-row")).toHaveCount(1);

    await page.getByRole("button", { name: /Modifier le blocage/ }).click();
    const form = page.getByTestId("manual-block-form");
    await expect(form.locator("input[name='startDate']")).toHaveValue(fd("2027-02-01").split("-").reverse().join("/"));
    await form.locator("input[name='endDate']").fill(fd("2027-02-10"));
    await form.getByRole("button", { name: "Enregistrer" }).click();

    await expect(page.getByText("Blocage modifié.")).toBeVisible();
    const end = fd("2027-02-10").split("-").reverse().join("/");
    await expect(page.getByTestId("manual-block-row")).toContainText(end);
    await expect(page.getByTestId("manual-block-row")).toHaveCount(1);
  });

  test("modifier un blocage avec fin avant début : refusé, blocage inchangé", async ({ page }) => {
    await openTab(page, "Blocages manuels");
    await page.getByRole("button", { name: "Ajouter" }).first().click();
    await page.locator("input[name='startDate']").fill(fd("2027-02-01"));
    await page.locator("input[name='endDate']").fill(fd("2027-02-05"));
    await page.getByRole("button", { name: "Créer le blocage" }).click();
    await expect(page.getByTestId("manual-block-row")).toHaveCount(1);

    await page.getByRole("button", { name: /Modifier le blocage/ }).click();
    const form = page.getByTestId("manual-block-form");
    await form.locator("input[name='endDate']").fill(fd("2027-01-20"));
    await form.getByRole("button", { name: "Enregistrer" }).click();
    await expect(page.getByText("La date de fin doit être après la date de début").first()).toBeVisible();
    await page.reload();
    await page.getByRole("tab", { name: "Blocages manuels" }).click();
    await expect(page.getByTestId("manual-block-row")).toContainText(fd("2027-02-05").split("-").reverse().join("/"));
  });

  // ─── Modifier : tarification ─────────────────────────────────────────────────

  test("modifier une règle tarifaire : le nouveau prix est facturé", async ({ page }) => {
    await openTab(page, "Tarification");
    await page.getByRole("button", { name: "Ajouter" }).click();
    await page.locator("input[name='name']").fill("Edit test");
    await page.locator("input[name='fixedPrice']").fill("150");
    await page.getByRole("button", { name: "Créer la règle" }).click();
    await expect(page.getByText("150 €/nuit")).toBeVisible();
    expect(await nightPrice(page, ctx.apiRoomId)).toBe(150);

    await page.getByRole("button", { name: "Modifier la règle Edit test" }).click();
    const form = page.getByTestId("pricing-rule-form");
    await expect(form.locator("input[name='fixedPrice']")).toHaveValue("150");
    await form.locator("input[name='name']").fill("Edit test 2");
    await form.locator("input[name='fixedPrice']").fill("175,5");
    await form.getByRole("button", { name: "Enregistrer" }).click();

    await expect(page.getByText("Règle tarifaire modifiée.")).toBeVisible();
    await expect(page.getByText("Edit test 2")).toBeVisible();
    await expect(page.getByTestId("pricing-rule-row")).toHaveCount(1);
    expect(await nightPrice(page, ctx.apiRoomId)).toBe(175.5);
  });

  test("passer une règle de prix fixe à un pourcentage", async ({ page }) => {
    await insertPricingRule({ tenantId: ctx.tenantId, name: "Bascule", fixedPrice: "150.00" });
    await openTab(page, "Tarification");
    await page.getByRole("button", { name: "Modifier la règle Bascule" }).click();
    const form = page.getByTestId("pricing-rule-form");
    await form.getByLabel("Hausse ou baisse en %").check();
    await form.locator("input[name='percentageModifier']").fill("-20");
    await form.getByRole("button", { name: "Enregistrer" }).click();
    await expect(page.getByText("-20%")).toBeVisible();
    await expect(page.getByText("150 €/nuit")).toHaveCount(0);
    expect(await nightPrice(page, ctx.apiRoomId)).toBe(80);
  });

  test("XSS dans le nom d'une règle modifiée : texte échappé, aucun dialog", async ({ page }) => {
    let dialog = false;
    page.on("dialog", () => (dialog = true));
    await insertPricingRule({ tenantId: ctx.tenantId, name: "Avant XSS", fixedPrice: "120.00" });
    await openTab(page, "Tarification");
    await page.getByRole("button", { name: "Modifier la règle Avant XSS" }).click();
    await page.getByTestId("pricing-rule-form").locator("input[name='name']").fill("<script>alert(1)</script>");
    await page.getByTestId("pricing-rule-form").getByRole("button", { name: "Enregistrer" }).click();
    await expect(page.getByText("<script>alert(1)</script>")).toBeVisible();
    expect(dialog).toBe(false);
  });

  // ─── Plusieurs chambres ─────────────────────────────────────────────────────

  test("une règle peut viser plusieurs chambres ; une chambre non cochée garde son prix", async ({ page }) => {
    await openTab(page, "Tarification");
    await page.getByRole("button", { name: "Ajouter" }).click();
    const form = page.getByTestId("pricing-rule-form");
    await form.locator("input[name='name']").fill("Deux chambres");
    await pill(form, "Chambre API Test").click();
    await pill(form, SECOND).click();
    await form.locator("input[name='fixedPrice']").fill("130");
    await form.getByRole("button", { name: "Créer la règle" }).click();

    const row = page.locator('[data-rule-name="Deux chambres"]');
    await expect(row).toContainText("Chambre API Test");
    await expect(row).toContainText(SECOND);
    expect(await nightPrice(page, ctx.apiRoomId)).toBe(130);
    expect(await nightPrice(page, secondRoomId)).toBe(130);

    // Décocher la seconde chambre : elle revient au prix de base.
    await page.getByRole("button", { name: "Modifier la règle Deux chambres" }).click();
    await expect(pill(page.getByTestId("pricing-rule-form"), SECOND)).toHaveAttribute("aria-pressed", "true");
    await pill(page.getByTestId("pricing-rule-form"), SECOND).click();
    await page.getByTestId("pricing-rule-form").getByRole("button", { name: "Enregistrer" }).click();
    await expect(row).not.toContainText(SECOND);
    expect(await nightPrice(page, secondRoomId)).toBe(100);
    expect(await nightPrice(page, ctx.apiRoomId)).toBe(130);
  });

  // ─── Blocages et règles de réservation sur plusieurs chambres ────────────────

  test("pastilles : « Toutes les chambres » par défaut ; choisir une chambre la désélectionne ; y revenir vide le choix", async ({ page }) => {
    await openTab(page, "Blocages manuels");
    await page.getByRole("button", { name: "Ajouter" }).first().click();
    const form = page.getByTestId("manual-block-form");
    await expect(pill(form, "Toutes les chambres")).toHaveAttribute("aria-pressed", "true");
    await pill(form, SECOND).click();
    await expect(pill(form, "Toutes les chambres")).toHaveAttribute("aria-pressed", "false");
    await expect(pill(form, SECOND)).toHaveAttribute("aria-pressed", "true");
    await expect(form.locator('input[name="roomIds"]')).toHaveCount(1);
    await pill(form, "Toutes les chambres").click();
    await expect(pill(form, SECOND)).toHaveAttribute("aria-pressed", "false");
    await expect(form.locator('input[name="roomIds"]')).toHaveCount(0);
  });

  test("blocage sur 2 chambres sur 3 : les deux bloquées, la troisième libre ; modifier → une seule", async ({ page }) => {
    await openTab(page, "Blocages manuels");
    await page.getByRole("button", { name: "Ajouter" }).first().click();
    const form = page.getByTestId("manual-block-form");
    await pill(form, "Chambre API Test").click();
    await pill(form, SECOND).click();
    await form.locator("input[name='startDate']").fill(fd("2027-05-02"));
    await form.locator("input[name='endDate']").fill(fd("2027-05-04"));
    await form.getByRole("button", { name: "Créer le blocage" }).click();
    await expect(page.getByText("Blocage ajouté.")).toBeVisible();
    const row = page.getByTestId("manual-block-row");
    await expect(row).toContainText(`Chambre API Test, ${SECOND}`);
    expect(await blockedDates(page, ctx.apiRoomId)).toHaveLength(2);
    expect(await blockedDates(page, secondRoomId)).toHaveLength(2);
    expect(await blockedDates(page, thirdRoomId)).toEqual([]);

    await row.getByRole("button", { name: /^Modifier le blocage/ }).click();
    await expect(pill(form, "Chambre API Test")).toHaveAttribute("aria-pressed", "true");
    await pill(form, "Chambre API Test").click();
    await form.getByRole("button", { name: "Enregistrer" }).click();
    await expect(page.getByText("Blocage modifié.")).toBeVisible();
    await expect(row).not.toContainText("Chambre API Test");
    expect(await blockedDates(page, ctx.apiRoomId)).toEqual([]);
    expect(await blockedDates(page, secondRoomId)).toHaveLength(2);
  });

  test("règle de réservation sur 2 chambres sur 3 : min 3 nuits pour elles seules", async ({ page }) => {
    await openTab(page, "Règles de réservation");
    await page.getByRole("button", { name: "Ajouter" }).first().click();
    const form = page.getByTestId("booking-rule-form");
    await pill(form, SECOND).click();
    await pill(form, THIRD).click();
    await form.locator("input[name='minStay']").fill("3");
    await form.getByRole("button", { name: "Créer la règle" }).click();
    await expect(page.getByTestId("booking-rule-row")).toContainText(`${SECOND}, ${THIRD}`);
    expect(await minStay(page, secondRoomId)).toBe(3);
    expect(await minStay(page, thirdRoomId)).toBe(3);
    expect(await minStay(page, ctx.apiRoomId)).toBeNull();
  });

  test("chambre forgée d'un autre établissement : refusée, jamais transformée en « toutes les chambres »", async ({ page }) => {
    const rival = (ctx as unknown as { rivalRoomId: string }).rivalRoomId;
    await openTab(page, "Règles de réservation");
    await page.getByRole("button", { name: "Ajouter" }).first().click();
    const form = page.getByTestId("booking-rule-form");
    await form.locator("input[name='minStay']").fill("5");
    await form.evaluate((f, id) => {
      const i = document.createElement("input");
      i.type = "hidden";
      i.name = "roomIds";
      i.value = id;
      f.appendChild(i);
    }, rival);
    await form.getByRole("button", { name: "Créer la règle" }).click();
    await expect(page.getByText("Les chambres choisies n'existent plus. Rechargez la page.").first()).toBeVisible();
    await expect(page.getByTestId("booking-rule-row")).toHaveCount(0);
    expect(await minStay(page, ctx.apiRoomId)).toBeNull();
  });

  test("supprimer une chambre : retirée des règles et blocages qui la visent, ceux qui ne visaient qu'elle sont supprimés", async ({ page }) => {
    const GONE = "Chambre Règles Supprimée";
    await deleteRoomsByName(ctx.tenantId, GONE);
    const goneId = await insertHiddenRoom(ctx.tenantId, GONE);
    await insertBookingRule({ tenantId: ctx.tenantId, roomIds: [goneId], minStay: 4 });
    await insertBookingRule({ tenantId: ctx.tenantId, roomIds: [goneId, secondRoomId], maxStay: 9 });
    await insertManualBlock({ tenantId: ctx.tenantId, roomIds: [goneId], startDate: new Date(fd("2027-05-02") + "T00:00:00Z"), endDate: new Date(fd("2027-05-03") + "T00:00:00Z") });
    await insertPricingRule({ tenantId: ctx.tenantId, name: "Seule", fixedPrice: "50.00", roomIds: [goneId] });

    await page.goto("/admin/chambres");
    const card = page.locator(`xpath=//div[.//div[normalize-space()="${GONE}"]][.//button[normalize-space()="Supprimer"]]`).last();
    await card.getByRole("button", { name: "Supprimer", exact: true }).click();
    await confirmDialog(page);
    await expect(page.getByText(GONE, { exact: true })).toHaveCount(0);

    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    try {
      const q = async (table: string) =>
        (await pool.query(`SELECT room_ids FROM ${table} WHERE tenant_id = $1`, [ctx.tenantId])).rows.map((r) => r.room_ids);
      expect(await q("booking_rules")).toEqual([[secondRoomId]]);
      expect(await q("manual_blocks")).toEqual([]);
      expect(await q("pricing_rules")).toEqual([]);
      // Aucune règle n'est devenue « toutes les chambres ».
      expect(await minStay(page, ctx.apiRoomId)).toBeNull();
    } finally {
      await pool.end();
    }
  });

  test("précédence : la règle visant moins de chambres l'emporte", async ({ page }) => {
    await insertPricingRule({ tenantId: ctx.tenantId, name: "Large", fixedPrice: "120.00", roomIds: [ctx.apiRoomId, secondRoomId] });
    await insertPricingRule({ tenantId: ctx.tenantId, name: "Étroite", fixedPrice: "90.00", roomIds: [ctx.apiRoomId] });
    expect(await nightPrice(page, ctx.apiRoomId)).toBe(90);
    expect(await nightPrice(page, secondRoomId)).toBe(120);
  });

  test("une valeur différente par chambre crée une règle par chambre remplie", async ({ page }) => {
    await openTab(page, "Tarification");
    await page.getByRole("button", { name: "Ajouter" }).click();
    const form = page.getByTestId("pricing-rule-form");
    await form.locator("input[name='name']").fill("Été par chambre");
    await form.locator("input[name='validFrom']").fill(fd("2027-02-01"));
    await form.locator("input[name='validTo']").fill(fd("2027-04-30"));
    await form.getByLabel("Une valeur différente pour chaque chambre").check();
    await form.getByLabel("Chambre API Test (€/nuit)").fill("140");
    await form.getByLabel(`${SECOND} (€/nuit)`).fill("95,50");
    await form.getByRole("button", { name: "Créer la règle" }).click();

    await expect(page.getByText("Règle tarifaire ajoutée.")).toBeVisible();
    // Un groupe = une seule ligne, avec le prix de chaque chambre.
    const row = page.locator('[data-rule-name="Été par chambre"]');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("Un prix par chambre · 2 chambres");
    await expect(row.getByTestId("pricing-group-values")).toContainText(/Chambre API Test 140\s€\/nuit/);
    await expect(row.getByTestId("pricing-group-values")).toContainText(/Chambre Règles Bis 95,50\s€\/nuit/);
    expect(await nightPrice(page, ctx.apiRoomId)).toBe(140);
    expect(await nightPrice(page, secondRoomId)).toBe(95.5);
  });

  // ─── Groupe « une valeur par chambre » : modifier en bloc ───────────────────

  async function createGroup(page: Page, name: string, values: [string, string]) {
    await openTab(page, "Tarification");
    await page.getByRole("button", { name: "Ajouter" }).click();
    const form = page.getByTestId("pricing-rule-form");
    await form.locator("input[name='name']").fill(name);
    await form.locator("input[name='validFrom']").fill(fd("2027-02-01"));
    await form.locator("input[name='validTo']").fill(fd("2027-04-30"));
    await form.getByLabel("Une valeur différente pour chaque chambre").check();
    await form.getByLabel("Chambre API Test (€/nuit)").fill(values[0]);
    await form.getByLabel(`${SECOND} (€/nuit)`).fill(values[1]);
    await form.getByRole("button", { name: "Créer la règle" }).click();
    await expect(page.getByText("Règle tarifaire ajoutée.")).toBeVisible();
  }

  test("modifier un groupe : prix pré-remplis, nouvelle période pour toutes, une chambre retirée puis rajoutée", async ({ page }) => {
    await createGroup(page, "Saison groupe", ["140", "95,50"]);
    await page.getByRole("button", { name: "Modifier la règle Saison groupe" }).click();
    const form = page.getByTestId("pricing-rule-form");
    await expect(form.getByLabel("Chambre API Test (€/nuit)")).toHaveValue("140");
    await expect(form.getByLabel(`${SECOND} (€/nuit)`)).toHaveValue("95,5");
    await expect(form.getByLabel("Une valeur différente pour chaque chambre")).toHaveCount(0);

    // Décaler la saison (le 1er mars n'y est plus), changer un prix, retirer une chambre.
    await form.locator("input[name='name']").fill("Saison décalée");
    await form.locator("input[name='validFrom']").fill(fd("2027-02-01"));
    await form.locator("input[name='validTo']").fill(fd("2027-02-28"));
    await form.getByLabel("Chambre API Test (€/nuit)").fill("");
    await form.getByLabel(`${SECOND} (€/nuit)`).fill("110");
    await form.getByRole("button", { name: "Enregistrer" }).click();
    await expect(page.getByText("Règles modifiées pour toutes les chambres du groupe.")).toBeVisible();
    const row = page.locator('[data-rule-name="Saison décalée"]');
    await expect(row).toContainText("1 chambre");
    await expect(row.getByTestId("pricing-group-values")).not.toContainText("Chambre API Test");
    expect(await nightPrice(page, ctx.apiRoomId)).toBe(100);
    expect(await nightPrice(page, secondRoomId)).toBe(100);

    // Remettre la saison en mars et rajouter la chambre : elle rejoint le groupe.
    await page.getByRole("button", { name: "Modifier la règle Saison décalée" }).click();
    await form.locator("input[name='validTo']").fill(fd("2027-04-30"));
    await form.getByLabel("Chambre API Test (€/nuit)").fill("130");
    await form.getByRole("button", { name: "Enregistrer" }).click();
    await expect(row).toContainText("2 chambres");
    expect(await nightPrice(page, ctx.apiRoomId)).toBe(130);
    expect(await nightPrice(page, secondRoomId)).toBe(110);
    await expect(page.getByTestId("pricing-rule-row")).toHaveCount(1);
  });

  test("modifier un groupe : prix invalide ou toutes chambres vidées → refusé, groupe inchangé", async ({ page }) => {
    await createGroup(page, "Groupe intact", ["140", "120"]);
    await page.getByRole("button", { name: "Modifier la règle Groupe intact" }).click();
    const form = page.getByTestId("pricing-rule-form");
    await form.getByLabel(`${SECOND} (€/nuit)`).fill("-5");
    await form.getByRole("button", { name: "Enregistrer" }).click();
    await expect(page.getByText(new RegExp(`${SECOND} : `)).first()).toBeVisible();

    await form.getByLabel("Chambre API Test (€/nuit)").fill("");
    await form.getByLabel(`${SECOND} (€/nuit)`).fill("");
    await form.getByRole("button", { name: "Enregistrer" }).click();
    await expect(page.getByText("Indiquez une valeur pour au moins une chambre")).toBeVisible();

    expect(await nightPrice(page, ctx.apiRoomId)).toBe(140);
    expect(await nightPrice(page, secondRoomId)).toBe(120);
  });

  test("désactiver puis supprimer un groupe agit sur toutes ses chambres", async ({ page }) => {
    await createGroup(page, "Groupe bloc", ["140", "120"]);
    const row = page.locator('[data-rule-name="Groupe bloc"]');
    await row.getByRole("button", { name: "Désactiver" }).click();
    await expect(row.getByText("Désactivée")).toBeVisible();
    expect(await nightPrice(page, ctx.apiRoomId)).toBe(100);
    expect(await nightPrice(page, secondRoomId)).toBe(100);

    await row.getByRole("button", { name: "Activer" }).click();
    await expect(row.getByText("Désactivée")).toHaveCount(0);
    expect(await nightPrice(page, secondRoomId)).toBe(120);

    await row.getByRole("button", { name: "Supprimer", exact: true }).click();
    await confirmDialog(page);
    await expect(page.getByText("Aucune règle tarifaire configurée")).toBeVisible();
    expect(await nightPrice(page, ctx.apiRoomId)).toBe(100);
    expect(await nightPrice(page, secondRoomId)).toBe(100);
  });

  test("valeur par chambre en pourcentage ; chambre laissée vide = pas de règle", async ({ page }) => {
    await openTab(page, "Tarification");
    await page.getByRole("button", { name: "Ajouter" }).click();
    const form = page.getByTestId("pricing-rule-form");
    await form.locator("input[name='name']").fill("Promo ciblée");
    await form.getByLabel("Hausse ou baisse en %").check();
    await form.getByLabel("Une valeur différente pour chaque chambre").check();
    await form.getByLabel(`${SECOND} (%)`).fill("-10");
    await form.getByRole("button", { name: "Créer la règle" }).click();

    await expect(page.locator('[data-rule-name="Promo ciblée"]')).toHaveCount(1);
    expect(await nightPrice(page, secondRoomId)).toBe(90);
    expect(await nightPrice(page, ctx.apiRoomId)).toBe(100);
  });

  test("valeur par chambre invalide ou toutes vides : refusé, rien n'est créé", async ({ page }) => {
    await openTab(page, "Tarification");
    await page.getByRole("button", { name: "Ajouter" }).click();
    const form = page.getByTestId("pricing-rule-form");
    await form.locator("input[name='name']").fill("Invalide");
    await form.getByLabel("Une valeur différente pour chaque chambre").check();
    await form.getByRole("button", { name: "Créer la règle" }).click();
    await expect(page.getByText("Indiquez une valeur pour au moins une chambre")).toBeVisible();

    await form.getByLabel("Chambre API Test (€/nuit)").fill("140");
    await form.getByLabel(`${SECOND} (€/nuit)`).fill("abc");
    await form.getByRole("button", { name: "Créer la règle" }).click();
    await expect(page.getByText(`${SECOND} : Format de prix invalide`).first()).toBeVisible();
    await expect(page.getByTestId("pricing-rule-row")).toHaveCount(0);
  });

  test("supprimer une règle multi-chambres la retire de toutes les chambres", async ({ page }) => {
    await insertPricingRule({ tenantId: ctx.tenantId, name: "À supprimer", fixedPrice: "160.00", roomIds: [ctx.apiRoomId, secondRoomId] });
    await openTab(page, "Tarification");
    await page.locator('[data-rule-name="À supprimer"]').getByRole("button", { name: "Supprimer", exact: true }).click();
    await confirmDialog(page);
    await expect(page.getByText("Aucune règle tarifaire configurée")).toBeVisible();
    expect(await nightPrice(page, ctx.apiRoomId)).toBe(100);
    expect(await nightPrice(page, secondRoomId)).toBe(100);
  });
});
