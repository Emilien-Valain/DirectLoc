import { test, expect, type Page } from "@playwright/test";
import { fillGuestContact } from "../helpers/guest";
import fs from "fs";
import path from "path";
import { Pool } from "pg";
import { cleanRules } from "../helpers/clean-rules";

/**
 * Spécification : Tests de non-régression > Public > Frais et taxe de séjour
 * Issues .scratch/mandatory-fees/01, 02 — ADR-0011.
 *
 * Chambre « Famille » (100 €/nuit, 6 pers.) + chambre « Autre » créées ici,
 * séjours à J+950…J+990. Sans vraie clé Stripe, un envoi admis s'arrête à
 * « paiement momentanément indisponible » : la preuve que l'admission est passée.
 */

const ctx = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "e2e", ".auth", "test-context.json"), "utf-8"),
) as { tenantId: string; apiRoomId: string; rivalTenantId: string };

const TAG = `fp${Date.now().toString(36).slice(-6)}`;
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const day = (n: number) => new Date(Date.now() + n * 86400000).toISOString().split("T")[0];
const stripeIsFake = () => {
  const k = process.env.STRIPE_SECRET_KEY ?? "";
  return !k || k.includes("XXXX") || k.includes("placeholder");
};

let family = { id: "", slug: "" };
let other = { id: "", slug: "" };

async function insertRoom(name: string, capacity: number) {
  const slug = `${name.toLowerCase()}-${TAG}`;
  const { rows } = await pool.query(
    `INSERT INTO rooms (tenant_id, property_id, name, slug, price_per_night, capacity)
     SELECT tenant_id, property_id, $1, $2, '100.00', $3 FROM rooms WHERE id = $4 RETURNING id`,
    [`${name} ${TAG}`, slug, capacity, ctx.apiRoomId],
  );
  return { id: rows[0].id as string, slug };
}

async function insertFee(label: string, price: string, unit: string, roomIds: string[] = []) {
  await pool.query(
    `INSERT INTO fees (tenant_id, label, price, unit, room_ids) VALUES ($1, $2, $3, $4, $5)`,
    [ctx.tenantId, `${label} ${TAG}`, price, unit, roomIds],
  );
}

async function setTax(tax: object | null) {
  await pool.query(
    tax
      ? `UPDATE tenants SET config = config || jsonb_build_object('touristTax', $2::jsonb) WHERE id = $1`
      : `UPDATE tenants SET config = config - 'touristTax' WHERE id = $1`,
    tax ? [ctx.tenantId, JSON.stringify(tax)] : [ctx.tenantId],
  );
}

async function cleanup() {
  await pool.query("DELETE FROM bookings WHERE guest_email LIKE $1", [`%@${TAG}.example`]);
  await pool.query("DELETE FROM fees WHERE tenant_id = $1", [ctx.tenantId]);
  await pool.query("DELETE FROM bookings WHERE room_id IN (SELECT id FROM rooms WHERE tenant_id = $1 AND slug ~ '-fp[0-9a-z]{6}$')", [ctx.tenantId]);
  await pool.query("DELETE FROM rooms WHERE tenant_id = $1 AND slug ~ '-fp[0-9a-z]{6}$'", [ctx.tenantId]);
  await setTax(null);
}

test.beforeAll(async () => {
  await cleanup();
  await cleanRules(ctx.tenantId);
  family = await insertRoom("Famille", 6);
  other = await insertRoom("Autre", 2);
});
test.afterAll(async () => {
  await cleanup();
  await pool.end();
});
test.afterEach(async () => {
  await pool.query("DELETE FROM fees WHERE tenant_id = $1", [ctx.tenantId]);
  await setTax(null);
});

// Budget de rate-limit propre à chaque test (5 envois / 10 min / IP).
test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders({
    "x-forwarded-for": `10.45.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`,
  });
});

async function openForm(page: Page, roomId: string, from: number, to: number, guests = "1") {
  await page.goto(`/reserver/${roomId}`);
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

const total = (page: Page) => page.getByTestId("booking-summary-total");
const fees = (page: Page) => page.getByTestId("booking-summary-fees");

test.describe("Public — Frais obligatoires", () => {
  test("ménage par séjour : ligne au récap, compté dans le total, sans case à cocher", async ({ page }) => {
    await insertFee("Ménage", "40", "per_stay");
    await openForm(page, family.id, 950, 952);
    await expect(fees(page)).toContainText(`Ménage ${TAG}`);
    await expect(total(page)).toHaveText(/240\s€/);
    await expect(page.getByTestId("booking-submit")).toContainText(/Payer 240\s€/);
    await expect(page.getByRole("checkbox", { name: new RegExp(`Ménage ${TAG}`) })).toHaveCount(0);
  });

  test("Fee par personne et par nuit suit le nombre de voyageurs", async ({ page }) => {
    await insertFee("Linge", "5", "per_guest_night");
    await openForm(page, family.id, 953, 955, "3");
    // 200 € + 3 × 2 × 5 €
    await expect(total(page)).toHaveText(/230\s€/);
    await page.fill("#guestCount", "1");
    await expect(total(page)).toHaveText(/210\s€/);
  });

  test("Fee limité à la chambre A absent sur la chambre B (formulaire et fiche)", async ({ page }) => {
    await insertFee("Jacuzzi", "15", "per_stay", [family.id]);
    await openForm(page, other.id, 956, 957);
    await expect(page.getByText(`Jacuzzi ${TAG}`)).toHaveCount(0);
    await expect(total(page)).toHaveText(/100\s€/);
    await page.goto(`/chambres/${other.slug}`);
    await expect(page.getByTestId("room-charges-note")).toHaveCount(0);
    await page.goto(`/chambres/${family.slug}`);
    await expect(page.getByTestId("room-charges-note")).toHaveText(`+ jacuzzi ${TAG.toLowerCase()}`);
  });

  test("fiche chambre : « + ménage et taxe de séjour » sous le prix", async ({ page }) => {
    await insertFee("Ménage", "40", "per_stay");
    await setTax({ mode: "fixed", amount: 1 });
    await page.goto(`/chambres/${family.slug}`);
    await expect(page.getByTestId("room-charges-note")).toHaveText(`+ ménage ${TAG} et taxe de séjour`);
  });

  test("ni Fee ni taxe : aucune mention, aucun champ enfants", async ({ page }) => {
    await page.goto(`/chambres/${family.slug}`);
    await expect(page.getByTestId("room-charges-note")).toHaveCount(0);
    await openForm(page, family.id, 958, 959);
    await expect(page.locator("#childCount")).toHaveCount(0);
    await expect(fees(page)).toHaveCount(0);
  });

  test("envoi avec Fee : admis jusqu'au paiement", async ({ page }) => {
    test.skip(!stripeIsFake(), "vraie clé Stripe : la redirection Stripe est couverte par booking-flow");
    await insertFee("Ménage", "40", "per_stay");
    await openForm(page, family.id, 960, 962);
    await fillGuestContact(page, { lastName: "Frais", email: `admis@${TAG}.example` });
    await page.getByTestId("booking-submit").click();
    await expect(page.getByTestId("booking-error")).toContainText("paiement en ligne est momentanément indisponible");
  });
});

test.describe("Public — Taxe de séjour", () => {
  test("fixe : 2 adultes + 2 enfants → taxe sur 2 adultes", async ({ page }) => {
    await setTax({ mode: "fixed", amount: 1.65 });
    await openForm(page, family.id, 965, 967, "4");
    // 4 pers. × 2 nuits × 1,65 €
    await expect(total(page)).toHaveText(/213,20\s€/);
    await page.fill("#childCount", "2");
    await expect(fees(page)).toContainText("Taxe de séjour");
    await expect(total(page)).toHaveText(/206,60\s€/);
  });

  test("que des enfants → taxe 0 €", async ({ page }) => {
    await setTax({ mode: "fixed", amount: 1.65 });
    await openForm(page, family.id, 968, 969, "2");
    await page.fill("#childCount", "2");
    await expect(total(page)).toHaveText(/100\s€/);
  });

  test("pourcentage : base HT ÷ occupants × adultes, taxes additionnelles", async ({ page }) => {
    await setTax({ mode: "percentage", rate: 5, cap: 4.9, vat: 0, additional: 10 });
    await openForm(page, family.id, 970, 971, "2");
    // 100 € ÷ 2 × 5 % = 2,50 € × 2 adultes × 1,10 = 5,50 €
    await expect(total(page)).toHaveText(/105,50\s€/);
  });

  test("plus d'enfants que de personnes : refusé par le serveur, rien en base", async ({ page }) => {
    await setTax({ mode: "fixed", amount: 1.65 });
    await openForm(page, family.id, 972, 973, "2");
    await fillGuestContact(page, { lastName: "Enfants", email: `enfants@${TAG}.example` });
    // Contourne le max du champ et sa remise en borne côté client.
    await page.locator("#childCount").evaluate((i: HTMLInputElement) => {
      i.removeAttribute("max");
      i.name = "ignored";
      const h = document.createElement("input");
      h.type = "hidden";
      h.name = "childCount";
      h.value = "5";
      i.form!.appendChild(h);
    });
    await page.getByTestId("booking-submit").click();
    await expect(page.getByTestId("booking-error")).toBeVisible();
    expect((await pool.query("SELECT 1 FROM bookings WHERE guest_email = $1", [`enfants@${TAG}.example`])).rowCount).toBe(0);
  });

  test("XSS dans le libellé d'un Fee : échappé au récap, aucun dialog", async ({ page }) => {
    let dialog = false;
    page.on("dialog", (d) => {
      dialog = true;
      void d.dismiss();
    });
    await insertFee("<script>alert(1)</script>", "5", "per_stay");
    await openForm(page, family.id, 975, 976);
    await expect(fees(page)).toContainText("<script>alert(1)</script>");
    expect(dialog).toBe(false);
  });
});
