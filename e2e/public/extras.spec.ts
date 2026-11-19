import { test, expect, type Page } from "@playwright/test";
import { fillGuestContact } from "../helpers/guest";
import fs from "fs";
import path from "path";
import { Pool } from "pg";
import { cleanRules } from "../helpers/clean-rules";

/**
 * Spécification : Tests de non-régression > Public > Réservation avec Extras
 * Issue .scratch/extras/02 — ADR-0010.
 *
 * Chambre API Test (100 €/nuit, 2 pers.), séjours à J+800…J+830. Sans vraie clé
 * Stripe, un envoi admis s'arrête à « paiement momentanément indisponible »
 * (pending retiré) : c'est la preuve que l'admission, Extras compris, est passée.
 */

const ctx = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "e2e", ".auth", "test-context.json"), "utf-8"),
) as { tenantId: string; apiRoomId: string; rivalTenantId: string };

const TAG = `xp${Date.now().toString(36).slice(-6)}`;
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const day = (n: number) => new Date(Date.now() + n * 86400000).toISOString().split("T")[0];
const stripeIsFake = () => {
  const k = process.env.STRIPE_SECRET_KEY ?? "";
  return !k || k.includes("XXXX") || k.includes("placeholder");
};

async function insertExtra(
  label: string,
  price: string,
  unit: string,
  opts: { active?: boolean; tenantId?: string; maxQuantity?: number } = {},
) {
  const { rows } = await pool.query(
    `INSERT INTO extras (tenant_id, label, price, unit, active, max_quantity) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [opts.tenantId ?? ctx.tenantId, `${label} ${TAG}`, price, unit, opts.active ?? true, opts.maxQuantity ?? null],
  );
  return rows[0].id as string;
}

test.beforeAll(async () => {
  await cleanRules(ctx.tenantId);
});
test.afterAll(async () => {
  await pool.query("DELETE FROM bookings WHERE guest_email LIKE $1", [`%@${TAG}.example`]);
  await pool.query("DELETE FROM extras WHERE label LIKE $1", [`%${TAG}%`]);
  await pool.end();
});

// Budget de rate-limit propre à chaque test (5 envois / 10 min / IP).
test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders({
    "x-forwarded-for": `10.44.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`,
  });
});

async function openForm(page: Page, from: number, to: number, guests = "1") {
  await page.goto(`/reserver/${ctx.apiRoomId}`);
  await page.waitForLoadState("networkidle");
  await expect(async () => {
    await page.fill("#checkIn", day(from));
    await page.fill("#checkOut", day(to));
    await expect(page.locator('[name="checkIn"]')).toHaveValue(day(from), { timeout: 500 });
  }).toPass({ timeout: 10_000 });
  await page.fill("#guestCount", guests);
  await page.locator("#guestCount").blur();
  await expect(page.getByText("Disponible", { exact: true })).toBeVisible({ timeout: 8000 });
}

async function fillGuest(page: Page, email: string) {
  await fillGuestContact(page, { lastName: "Extras", email });
}

const total = (page: Page) => page.getByTestId("booking-summary-total");

test.describe("Public — Réservation avec Extras", () => {
  test("petit-déj coché : prix calculé, ligne au récap, total = hébergement + Extra", async ({ page }) => {
    await insertExtra("Petit-déjeuner", "12.50", "per_guest_night");
    await openForm(page, 800, 803, "2");
    await expect(total(page)).toHaveText(/300\s€/);

    const box = page.getByTestId("booking-extras").locator("label").filter({ hasText: `Petit-déjeuner ${TAG}` });
    // 3 nuits × 2 pers. × 12,50 € = 75 €
    await expect(box.getByTestId("booking-extra-price")).toHaveText(/75\s€/);
    await box.locator("input").check();
    await expect(page.getByTestId("booking-summary-extras")).toContainText(`Petit-déjeuner ${TAG}`);
    await expect(page.getByTestId("booking-summary-extras")).toContainText(/6 × 12,50\s€/);
    await expect(total(page)).toHaveText(/375\s€/);
    await expect(page.getByTestId("booking-submit")).toContainText(/Payer 375\s€/);

    // Le prix suit le nombre de voyageurs.
    await page.fill("#guestCount", "1");
    await expect(total(page)).toHaveText(/337,50\s€/);

    await box.locator("input").uncheck();
    await expect(total(page)).toHaveText(/300\s€/);
  });

  test("envoi avec Extra : admis jusqu'au paiement (le serveur recalcule, aucun montant du formulaire)", async ({ page }) => {
    test.skip(!stripeIsFake(), "vraie clé Stripe : la redirection Stripe est couverte par booking-flow");
    await insertExtra("Linge", "15", "per_stay");
    const email = `admis@${TAG}.example`;
    await openForm(page, 806, 808);
    await page.getByLabel(new RegExp(`Linge ${TAG}`)).check();
    await fillGuest(page, email);
    // Un total forgé dans le formulaire est ignoré : il n'existe même pas de champ serveur.
    await page.locator("form").evaluate((f: HTMLFormElement) => {
      const i = document.createElement("input");
      i.type = "hidden";
      i.name = "totalPrice";
      i.value = "1";
      f.appendChild(i);
    });
    await page.getByTestId("booking-submit").click();
    await expect(page.getByTestId("booking-error")).toContainText("paiement en ligne est momentanément indisponible");
    // Pending retiré, lignes d'Extras avec (cascade).
    expect((await pool.query("SELECT 1 FROM bookings WHERE guest_email = $1", [email])).rowCount).toBe(0);
  });

  test("Extra inactif absent du formulaire", async ({ page }) => {
    await insertExtra("Inactif", "5", "per_stay", { active: false });
    await insertExtra("Visible", "5", "per_stay");
    await page.goto(`/reserver/${ctx.apiRoomId}`);
    await expect(page.getByText(`Visible ${TAG}`)).toBeVisible();
    await expect(page.getByText(`Inactif ${TAG}`)).toHaveCount(0);
  });

  test("Extra d'un autre tenant absent du formulaire", async ({ page }) => {
    await insertExtra("Rival", "5", "per_stay", { tenantId: ctx.rivalTenantId });
    await page.goto(`/reserver/${ctx.apiRoomId}`);
    await expect(page.getByText(`Rival ${TAG}`)).toHaveCount(0);
  });

  test("limite : 1 nuit / 1 personne, et Extra à 0 € affiché « Offert » sans changer le total", async ({ page }) => {
    await insertExtra("Lit bébé", "0", "per_stay");
    await insertExtra("Café", "4", "per_guest_night");
    await openForm(page, 810, 811, "1");
    await page.getByLabel(new RegExp(`Café ${TAG}`)).check();
    await expect(total(page)).toHaveText(/104\s€/);
    const cot = page.getByTestId("booking-extras").locator("label").filter({ hasText: `Lit bébé ${TAG}` });
    await expect(cot.getByTestId("booking-extra-price")).toHaveText("Offert");
    await cot.locator("input").check();
    await expect(page.getByTestId("booking-summary-extras")).toContainText("Offert");
    await expect(total(page)).toHaveText(/104\s€/);
  });

  test("id inactif, d'un autre tenant ou mal formé injecté : refusé, rien en base", async ({ page }) => {
    const inactive = await insertExtra("Caché", "5", "per_stay", { active: false });
    const rival = await insertExtra("Ailleurs", "5", "per_stay", { tenantId: ctx.rivalTenantId });
    const email = `injecte@${TAG}.example`;
    for (const id of [inactive, rival, "pas-un-uuid"]) {
      await openForm(page, 815, 817);
      await fillGuest(page, email);
      await page.locator("form").evaluate((f: HTMLFormElement, v) => {
        const i = document.createElement("input");
        i.type = "hidden";
        i.name = "extraIds";
        i.value = v;
        f.appendChild(i);
      }, id);
      await page.getByTestId("booking-submit").click();
      await expect(page.getByTestId("booking-error")).toContainText("option choisie n'est plus proposée");
      // Saisie conservée après le refus.
      await expect(page.locator('[name="guestEmail"]')).toHaveValue(email);
    }
    expect((await pool.query("SELECT 1 FROM bookings WHERE guest_email = $1", [email])).rowCount).toBe(0);
  });

  test("aucun Extra au catalogue : pas de section Options, flux inchangé", async ({ page }) => {
    // Désactive temporairement tout le catalogue du tenant (rétabli en finally).
    const { rows } = await pool.query(
      "UPDATE extras SET active = false WHERE tenant_id = $1 AND active RETURNING id",
      [ctx.tenantId],
    );
    try {
      await openForm(page, 820, 822);
      await expect(page.getByTestId("booking-extras")).toHaveCount(0);
      await expect(total(page)).toHaveText(/200\s€/);
    } finally {
      if (rows.length) await pool.query("UPDATE extras SET active = true WHERE id = ANY($1)", [rows.map((r) => r.id)]);
    }
  });
});

test.describe("Public — Option par lit (draps)", () => {
  test.beforeAll(async () => {
    await pool.query("UPDATE rooms SET beds = 3 WHERE id = $1", [ctx.apiRoomId]);
  });
  test.afterAll(async () => {
    await pool.query("UPDATE rooms SET beds = NULL WHERE id = $1", [ctx.apiRoomId]);
  });

  test("cocher l'option : choix du nombre de lits (3 par défaut), prix et total suivent", async ({ page }) => {
    const id = await insertExtra("Draps", "8", "per_bed");
    await openForm(page, 812, 814);
    await expect(total(page)).toHaveText(/200\s€/);
    const box = page.getByTestId("booking-extras").locator("label").filter({ hasText: `Draps ${TAG}` });
    await expect(box).toContainText("8 € par lit");
    await expect(page.locator(`#extraQty-${id}`)).toHaveCount(0);
    await box.locator("input").check();

    const qty = page.getByLabel("Pour combien de lits ?");
    await expect(qty).toHaveValue("3");
    await expect(qty.locator("option")).toHaveCount(3);
    await expect(total(page)).toHaveText(/224\s€/);
    await qty.selectOption("1");
    await expect(box.getByTestId("booking-extra-price")).toHaveText(/8\s€/);
    await expect(total(page)).toHaveText(/208\s€/);

    await box.locator("input").uncheck();
    await expect(qty).toHaveCount(0);
    await expect(total(page)).toHaveText(/200\s€/);
  });

  test("lits non renseignés : borné à la capacité (2) ; 1 seul lit : pas de choix", async ({ page }) => {
    await pool.query("UPDATE rooms SET beds = NULL WHERE id = $1", [ctx.apiRoomId]);
    await insertExtra("Draps cap", "8", "per_bed");
    await openForm(page, 816, 817);
    await page.getByTestId("booking-extras").locator("label").filter({ hasText: `Draps cap ${TAG}` }).locator("input").check();
    await expect(page.getByLabel("Pour combien de lits ?").locator("option")).toHaveCount(2);

    await pool.query("UPDATE rooms SET beds = 1 WHERE id = $1", [ctx.apiRoomId]);
    await openForm(page, 816, 817);
    await page.getByTestId("booking-extras").locator("label").filter({ hasText: `Draps cap ${TAG}` }).locator("input").check();
    await expect(page.getByLabel("Pour combien de lits ?")).toHaveCount(0);
    await expect(total(page)).toHaveText(/108\s€/);
    await pool.query("UPDATE rooms SET beds = 3 WHERE id = $1", [ctx.apiRoomId]);
  });
});

test.describe("Public — Option à nombre au choix", () => {
  test("« Combien ? » de 1 au maximum, 1 par défaut ; prix et total suivent ; option sans maximum : pas de choix", async ({ page }) => {
    const id = await insertExtra("Panier pique-nique", "15", "per_stay", { maxQuantity: 3 });
    const plain = await insertExtra("Bouquet", "20", "per_stay");
    await openForm(page, 820, 822);
    await expect(total(page)).toHaveText(/200\s€/);
    const box = page.getByTestId("booking-extras").locator("label").filter({ hasText: `Panier pique-nique ${TAG}` });
    await box.locator("input").check();
    const qty = page.locator(`#extraQty-${id}`);
    await expect(page.getByLabel("Combien ?")).toHaveValue("1");
    await expect(qty.locator("option")).toHaveText(["1", "2", "3"]);
    await expect(total(page)).toHaveText(/215\s€/);
    await qty.selectOption("3");
    await expect(box.getByTestId("booking-extra-price")).toHaveText(/45\s€/);
    await expect(total(page)).toHaveText(/245\s€/);

    await page.getByTestId("booking-extras").locator("label").filter({ hasText: `Bouquet ${TAG}` }).locator("input").check();
    await expect(page.locator(`#extraQty-${plain}`)).toHaveCount(0);
    await expect(total(page)).toHaveText(/265\s€/);
  });
});
