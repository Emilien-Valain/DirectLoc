import { test, expect, type Page } from "@playwright/test";
import fs from "fs";
import path from "path";
import { Pool } from "pg";
import { confirmDialog, SAVED_BOOKING_URL } from "../helpers/confirm";

/**
 * Spécification : Tests de non-régression > Admin > Frais et taxe de séjour
 * Issues .scratch/mandatory-fees/01, 02 — ADR-0011.
 *
 * Une chambre « Famille » (100 €/nuit, 6 pers.) est créée pour l'occasion, plus
 * une 2e chambre pour les Fees restreints. Séjours à J+900…J+990. Fees et réglage
 * de taxe sont remis à zéro avant et après (les autres specs n'en voient jamais).
 */

const ctx = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "e2e", ".auth", "test-context.json"), "utf-8"),
) as { tenantId: string; apiRoomId: string; rivalTenantId: string };

const RUN_ID = Date.now().toString(36).slice(-6);
const TAG = `ft${RUN_ID}`;
const DOMAIN = "fees-tax.example";
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const day = (n: number) => new Date(Date.now() + n * 86400000).toISOString().split("T")[0];

let familyRoomId = "";
let otherRoomId = "";

async function insertRoom(name: string, capacity: number) {
  const { rows } = await pool.query(
    `INSERT INTO rooms (tenant_id, property_id, name, slug, price_per_night, capacity)
     SELECT tenant_id, property_id, $1, $2, '100.00', $3 FROM rooms WHERE id = $4 RETURNING id`,
    [`${name} ${TAG}`, `${name.toLowerCase()}-${TAG}`, capacity, ctx.apiRoomId],
  );
  return rows[0].id as string;
}

async function insertFee(opts: { label: string; price: string; unit: string; roomIds?: string[]; tenantId?: string; active?: boolean }) {
  const { rows } = await pool.query(
    `INSERT INTO fees (tenant_id, label, price, unit, room_ids, active) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [opts.tenantId ?? ctx.tenantId, `${opts.label} ${TAG}`, opts.price, opts.unit, opts.roomIds ?? [], opts.active ?? true],
  );
  return rows[0].id as string;
}

async function setTax(tax: object | null) {
  await pool.query(
    tax
      ? `UPDATE tenants SET config = config || jsonb_build_object('touristTax', $2::jsonb) WHERE id = $1`
      : `UPDATE tenants SET config = config - 'touristTax' WHERE id = $1`,
    tax ? [ctx.tenantId, JSON.stringify(tax)] : [ctx.tenantId],
  );
}

async function lines(bookingId: string) {
  const { rows } = await pool.query(
    "SELECT kind, label, unit_price, quantity, total, exempt FROM booking_lines WHERE booking_id = $1 ORDER BY kind, label",
    [bookingId],
  );
  return rows as { kind: string; label: string; unit_price: string; quantity: number; total: string; exempt: boolean }[];
}

async function totalOf(bookingId: string) {
  const { rows } = await pool.query("SELECT total_price FROM bookings WHERE id = $1", [bookingId]);
  return rows[0].total_price as string;
}

async function cleanup() {
  await pool.query("DELETE FROM bookings WHERE guest_email LIKE $1", [`%@${DOMAIN}`]);
  // Résidus d'une exécution interrompue : tous les Fees du tenant de test sont à ce spec.
  await pool.query("DELETE FROM fees WHERE tenant_id = $1 OR label LIKE $2", [ctx.tenantId, `%${TAG}%`]);
  await pool.query("DELETE FROM bookings WHERE room_id IN (SELECT id FROM rooms WHERE tenant_id = $1 AND slug ~ '-ft[0-9a-z]{6}$')", [ctx.tenantId]);
  await pool.query("DELETE FROM rooms WHERE tenant_id = $1 AND slug ~ '-ft[0-9a-z]{6}$'", [ctx.tenantId]);
  await setTax(null);
}

test.beforeAll(async () => {
  await cleanup();
  familyRoomId = await insertRoom("Famille", 6);
  otherRoomId = await insertRoom("Autre", 2);
});
test.afterAll(async () => {
  await cleanup();
  await pool.end();
});
test.afterEach(async () => {
  await pool.query("DELETE FROM fees WHERE tenant_id = $1", [ctx.tenantId]);
  await setTax(null);
});

const settingsSection = (page: Page, title: string) =>
  page.locator("section").filter({ has: page.getByRole("heading", { name: title, exact: true }) });

async function openSettings(page: Page) {
  await page.goto("/admin/parametres?tab=etablissement");
  await expect(page.getByRole("heading", { name: "Frais", exact: true })).toBeVisible();
}

async function addFee(page: Page, label: string, price: string, unit = "per_stay") {
  await settingsSection(page, "Frais").getByRole("button", { name: "Ajouter", exact: true }).click();
  const form = page.getByTestId("fee-form");
  await form.locator('[name="label"]').fill(label);
  await form.locator('[name="price"]').fill(price);
  await form.locator('[name="unit"]').selectOption(unit);
  return form;
}

const feeRow = (page: Page, label: string) => page.locator(`[data-testid="fee-row"][data-fee-label="${label}"]`);

async function fillManual(page: Page, opts: { name: string; checkIn: string; checkOut: string; guests?: string; roomId?: string }) {
  await page.goto("/admin/reservations/new");
  await page.locator('select[name="roomId"]').selectOption(opts.roomId ?? familyRoomId);
  await page.fill('[name="guestName"]', `${opts.name} ${RUN_ID}`);
  await page.fill('[name="guestEmail"]', `${RUN_ID}@${DOMAIN}`);
  await page.fill('[name="guestCount"]', opts.guests ?? "1");
  await page.locator('[name="checkIn"]').fill(opts.checkIn);
  await page.locator('[name="checkOut"]').fill(opts.checkOut);
}

const quote = (page: Page) => page.locator('[aria-live="polite"]').first();

async function save(page: Page) {
  await page.click('[type="submit"]');
  await expect(page).toHaveURL(SAVED_BOOKING_URL);
  return page.url().match(/reservations\/([0-9a-f-]{36})/)![1];
}

async function saveEdit(page: Page, id: string) {
  await page.locator('[name="notifyGuest"]').uncheck();
  await page.getByRole("button", { name: "Enregistrer les modifications" }).click();
  await expect(page).toHaveURL(`/admin/reservations/${id}?modifiee=silence`);
}

// ─── Fees : catalogue (issue 01) ───────────────────────────────────────────────

test.describe("Admin — Frais (catalogue)", () => {
  test("créer (restreint à une chambre), modifier, désactiver, supprimer", async ({ page }) => {
    const label = `Ménage ${TAG}`;
    await openSettings(page);
    const form = await addFee(page, label, "40");
    await form.getByLabel(`Famille ${TAG}`).check();
    await form.getByRole("button", { name: "Ajouter le frais" }).click();
    await expect(feeRow(page, label)).toContainText(`40 € par séjour · Famille ${TAG}`);
    const { rows } = await pool.query("SELECT room_ids FROM fees WHERE label = $1", [label]);
    expect(rows[0].room_ids).toEqual([familyRoomId]);

    await feeRow(page, label).getByRole("button", { name: "Modifier" }).click();
    await page.getByTestId("fee-form").getByLabel(`Famille ${TAG}`).uncheck();
    await page.getByTestId("fee-form").locator('[name="price"]').fill("45,50");
    await page.getByRole("button", { name: "Enregistrer le frais" }).click();
    await expect(feeRow(page, label)).toContainText("45,50 € par séjour · toutes les chambres");

    await feeRow(page, label).getByRole("button", { name: "Désactiver" }).click();
    await expect(feeRow(page, label)).toContainText("Désactivé");

    await feeRow(page, label).getByRole("button", { name: "Supprimer" }).click();
    await confirmDialog(page);
    await expect(feeRow(page, label)).toHaveCount(0);
  });

  test("limite : Fee à 0 € accepté", async ({ page }) => {
    await openSettings(page);
    const form = await addFee(page, `Dossier ${TAG}`, "0");
    await form.getByRole("button", { name: "Ajouter le frais" }).click();
    await expect(feeRow(page, `Dossier ${TAG}`)).toContainText("Gratuit");
  });

  test("prix négatif refusé, rien en base", async ({ page }) => {
    await openSettings(page);
    const form = await addFee(page, `Négatif ${TAG}`, "-5");
    await form.evaluate((f: HTMLFormElement) => (f.noValidate = true));
    await form.getByRole("button", { name: "Ajouter le frais" }).click();
    await expect(form.locator('[name="price"]')).toHaveAttribute("aria-invalid", "true");
    expect((await pool.query("SELECT 1 FROM fees WHERE label = $1", [`Négatif ${TAG}`])).rowCount).toBe(0);
  });

  test("XSS dans le libellé : affiché échappé, aucun dialog", async ({ page }) => {
    let dialog = false;
    page.on("dialog", (d) => {
      dialog = true;
      void d.dismiss();
    });
    const label = `<script>alert(1)</script> ${TAG}`;
    await openSettings(page);
    const form = await addFee(page, label, "1");
    await form.getByRole("button", { name: "Ajouter le frais" }).click();
    await expect(feeRow(page, label)).toContainText("<script>alert(1)</script>");
    expect(dialog).toBe(false);
  });

  test("isolation : Fee d'un autre tenant invisible ; chambre d'un autre tenant ignorée", async ({ page }) => {
    await insertFee({ label: "Rival", price: "9", unit: "per_stay", tenantId: ctx.rivalTenantId });
    await openSettings(page);
    await expect(page.getByText(`Rival ${TAG}`)).toHaveCount(0);

    const label = `Forgé ${TAG}`;
    const form = await addFee(page, label, "3");
    await form.evaluate((f: HTMLFormElement) => {
      const i = document.createElement("input");
      i.type = "hidden";
      i.name = "roomIds";
      i.value = "00000000-0000-4000-8000-000000000000";
      f.appendChild(i);
    });
    await form.getByRole("button", { name: "Ajouter le frais" }).click();
    await expect(feeRow(page, label)).toBeVisible();
    const { rows } = await pool.query("SELECT room_ids FROM fees WHERE label = $1", [label]);
    expect(rows[0].room_ids).toEqual([]);
  });
});

// ─── Fees : réservation manuelle (issue 01) ────────────────────────────────────

test.describe("Admin — Réservation manuelle avec Frais", () => {
  test("Fee coché d'office → ligne fee, total = hébergement + Fee", async ({ page }) => {
    await insertFee({ label: "Ménage", price: "40", unit: "per_stay" });
    await fillManual(page, { name: "Ménage Auto", checkIn: day(900), checkOut: day(902) });
    await expect(page.getByLabel(`Ménage ${TAG}`)).toBeChecked();
    await expect(quote(page)).toContainText(/240\s€/);
    const id = await save(page);
    expect(await totalOf(id)).toBe("240.00");
    expect(await lines(id)).toMatchObject([{ kind: "fee", label: `Ménage ${TAG}`, total: "40.00" }]);
    await expect(page.getByText(`Ménage ${TAG}`)).toBeVisible();
  });

  test("admin décoche le ménage → total sans, aucune ligne", async ({ page }) => {
    await insertFee({ label: "Ménage", price: "40", unit: "per_stay" });
    await fillManual(page, { name: "Ménage Offert", checkIn: day(904), checkOut: day(905) });
    await page.getByLabel(`Ménage ${TAG}`).uncheck();
    await expect(quote(page)).toContainText(/100\s€/);
    const id = await save(page);
    expect(await totalOf(id)).toBe("100.00");
    expect(await lines(id)).toEqual([]);
  });

  test("Fee limité à la chambre A absent sur la chambre B", async ({ page }) => {
    await insertFee({ label: "Jacuzzi", price: "15", unit: "per_stay", roomIds: [familyRoomId] });
    await fillManual(page, { name: "Chambre B", checkIn: day(906), checkOut: day(907), roomId: otherRoomId });
    await expect(page.getByText(`Jacuzzi ${TAG}`)).toHaveCount(0);
    await page.locator('select[name="roomId"]').selectOption(familyRoomId);
    await expect(page.getByLabel(`Jacuzzi ${TAG}`)).toBeChecked();
    await page.locator('select[name="roomId"]').selectOption(otherRoomId);
    const id = await save(page);
    expect(await lines(id)).toEqual([]);
  });

  test("Fee d'une autre chambre injecté : refusé, rien en base", async ({ page }) => {
    const feeId = await insertFee({ label: "Ailleurs", price: "15", unit: "per_stay", roomIds: [familyRoomId] });
    await fillManual(page, { name: "Injecté", checkIn: day(908), checkOut: day(909), roomId: otherRoomId });
    await page.locator("form").evaluate((f: HTMLFormElement, v) => {
      const i = document.createElement("input");
      i.type = "hidden";
      i.name = "feeIds";
      i.value = v;
      f.appendChild(i);
    }, feeId);
    await page.click('[type="submit"]');
    await expect(page.getByText(/frais coché n.est plus appliqué/)).toBeVisible();
    expect((await pool.query("SELECT 1 FROM bookings WHERE guest_name = $1", [`Injecté ${RUN_ID}`])).rowCount).toBe(0);
  });

  test("Fee à 0 € : ligne à 0, total inchangé", async ({ page }) => {
    await insertFee({ label: "Dossier", price: "0", unit: "per_stay" });
    await fillManual(page, { name: "Gratuit", checkIn: day(910), checkOut: day(911) });
    const id = await save(page);
    expect(await totalOf(id)).toBe("100.00");
    expect(await lines(id)).toMatchObject([{ kind: "fee", total: "0.00" }]);
  });

  test("3 → 5 nuits recalcule un Fee par nuit au taux figé", async ({ page }) => {
    const feeId = await insertFee({ label: "Linge", price: "10", unit: "per_night" });
    await fillManual(page, { name: "Allonge", checkIn: day(912), checkOut: day(915) });
    const id = await save(page);
    expect(await totalOf(id)).toBe("330.00");

    await pool.query("UPDATE fees SET price = '99' WHERE id = $1", [feeId]);
    await page.goto(`/admin/reservations/${id}/modifier`);
    await expect(page.getByLabel(`Linge ${TAG}`)).toBeChecked();
    await page.locator('[name="checkOut"]').fill(day(917));
    await expect(quote(page)).toContainText(/550\s€/);
    await saveEdit(page, id);
    expect(await totalOf(id)).toBe("550.00");
    expect(await lines(id)).toMatchObject([{ kind: "fee", unit_price: "10.00", quantity: 5, total: "50.00" }]);
  });

  test("modification d'un ancien séjour : un Fee créé depuis n'est pas ajouté d'office", async ({ page }) => {
    await fillManual(page, { name: "Ancien", checkIn: day(918), checkOut: day(919) });
    const id = await save(page);
    await insertFee({ label: "Nouveau", price: "20", unit: "per_stay" });
    await page.goto(`/admin/reservations/${id}/modifier`);
    await expect(page.getByLabel(`Nouveau ${TAG}`)).not.toBeChecked();
    await saveEdit(page, id);
    expect(await totalOf(id)).toBe("100.00");
  });
});

// ─── Taxe de séjour (issue 02) ─────────────────────────────────────────────────

test.describe("Admin — Taxe de séjour", () => {
  test("réglage : désactivée → fixe → pourcentage, enregistré dans la config", async ({ page }) => {
    await openSettings(page);
    const s = settingsSection(page, "Taxe de séjour");
    await s.locator('[name="mode"]').selectOption("fixed");
    await s.locator('[name="amount"]').fill("1,65");
    await s.getByRole("button", { name: "Enregistrer" }).click();
    await expect(s.getByText("Taxe de séjour enregistrée.")).toBeVisible();
    let { rows } = await pool.query("SELECT config->'touristTax' AS t FROM tenants WHERE id = $1", [ctx.tenantId]);
    expect(rows[0].t).toEqual({ mode: "fixed", amount: 1.65 });

    await s.locator('[name="mode"]').selectOption("percentage");
    await s.locator('[name="rate"]').fill("5");
    await s.locator('[name="cap"]').fill("4,90");
    await s.getByRole("button", { name: "Enregistrer" }).click();
    await expect(s.getByText("Taxe de séjour enregistrée.")).toBeVisible();
    ({ rows } = await pool.query("SELECT config->'touristTax' AS t FROM tenants WHERE id = $1", [ctx.tenantId]));
    expect(rows[0].t).toEqual({ mode: "percentage", rate: 5, cap: 4.9, vat: 10, additional: 10 });

    await s.locator('[name="mode"]').selectOption("off");
    await s.getByRole("button", { name: "Enregistrer" }).click();
    await expect(s.getByText("Taxe de séjour enregistrée.")).toBeVisible();
    ({ rows } = await pool.query("SELECT config->'touristTax' AS t FROM tenants WHERE id = $1", [ctx.tenantId]));
    expect(rows[0].t).toBeNull();
  });

  test("taux négatif, taux > 5 % et montant invalide refusés, rien enregistré", async ({ page }) => {
    await openSettings(page);
    const s = settingsSection(page, "Taxe de séjour");
    await s.locator('[name="mode"]').selectOption("percentage");
    await s.locator('[name="rate"]').fill("-2");
    await s.locator('[name="cap"]').fill("4");
    await s.getByRole("button", { name: "Enregistrer" }).click();
    await expect(s.locator('[name="rate"]')).toHaveAttribute("aria-invalid", "true");
    await s.locator('[name="rate"]').fill("8");
    await s.getByRole("button", { name: "Enregistrer" }).click();
    await expect(s.getByText(/5 maximum/).first()).toBeVisible();

    await s.locator('[name="mode"]').selectOption("fixed");
    await s.locator('[name="amount"]').fill("abc");
    await s.getByRole("button", { name: "Enregistrer" }).click();
    await expect(s.locator('[name="amount"]')).toHaveAttribute("aria-invalid", "true");
    const { rows } = await pool.query("SELECT config->'touristTax' AS t FROM tenants WHERE id = $1", [ctx.tenantId]);
    expect(rows[0].t).toBeNull();
  });

  test("mode off : aucun champ enfants, aucune ligne de taxe", async ({ page }) => {
    await fillManual(page, { name: "Sans Taxe", checkIn: day(920), checkOut: day(921) });
    await expect(page.locator('[name="childCount"]')).toHaveCount(0);
    const id = await save(page);
    expect(await lines(id)).toEqual([]);
  });

  test("fixe : 2 adultes + 2 enfants × 2 nuits → taxe sur 2 adultes", async ({ page }) => {
    await setTax({ mode: "fixed", amount: 1.65 });
    await fillManual(page, { name: "Famille Fixe", checkIn: day(922), checkOut: day(924), guests: "4" });
    await page.fill('[name="childCount"]', "2");
    // 200 € + 2 adultes × 2 nuits × 1,65 € = 206,60 €
    await expect(quote(page)).toContainText(/206,60\s€/);
    const id = await save(page);
    expect(await totalOf(id)).toBe("206.60");
    expect(await lines(id)).toMatchObject([{ kind: "tax", label: "Taxe de séjour", quantity: 4, total: "6.60", exempt: false }]);
    await expect(page.getByText("4 personnes dont 2 enfants")).toBeVisible();
  });

  test("que des enfants → taxe à 0 €", async ({ page }) => {
    await setTax({ mode: "fixed", amount: 1.65 });
    await fillManual(page, { name: "Enfants", checkIn: day(925), checkOut: day(926), guests: "2" });
    await page.fill('[name="childCount"]', "2");
    const id = await save(page);
    expect(await totalOf(id)).toBe("100.00");
    expect(await lines(id)).toMatchObject([{ kind: "tax", quantity: 0, total: "0.00" }]);
  });

  test("plus d'enfants que de personnes refusé, rien en base", async ({ page }) => {
    await setTax({ mode: "fixed", amount: 1.65 });
    await fillManual(page, { name: "Trop Enfants", checkIn: day(927), checkOut: day(928), guests: "2" });
    await page.fill('[name="childCount"]', "3");
    await page.click('[type="submit"]');
    await expect(page.locator('[name="childCount"]')).toHaveAttribute("aria-invalid", "true");
    expect((await pool.query("SELECT 1 FROM bookings WHERE guest_name = $1", [`Trop Enfants ${RUN_ID}`])).rowCount).toBe(0);
  });

  test("pourcentage : le prix convenu change la taxe", async ({ page }) => {
    await setTax({ mode: "percentage", rate: 5, cap: 4.9, vat: 0, additional: 0 });
    await fillManual(page, { name: "Pct", checkIn: day(930), checkOut: day(932), guests: "2" });
    // 100 €/nuit ÷ 2 pers. × 5 % = 2,50 € × 2 adultes × 2 nuits = 10 €
    await expect(quote(page)).toContainText(/210\s€/);
    // Prix convenu 120 € → 60 €/nuit ÷ 2 × 5 % = 1,50 € × 4 = 6 €
    await page.fill('[name="agreedPrice"]', "120");
    await expect(quote(page)).toContainText(/126\s€/);
    const id = await save(page);
    expect(await totalOf(id)).toBe("126.00");
    expect(await lines(id)).toMatchObject([{ kind: "tax", total: "6.00" }]);
  });

  test("exonération : ligne gardée à 0 €, marquée exempt, affichée « Exonérée » ; levée à la modification", async ({ page }) => {
    await setTax({ mode: "fixed", amount: 2 });
    await fillManual(page, { name: "Exonéré", checkIn: day(934), checkOut: day(936) });
    await page.getByLabel("Exonérer de la taxe de séjour").check();
    await expect(quote(page)).toContainText(/200\s€/);
    const id = await save(page);
    expect(await totalOf(id)).toBe("200.00");
    expect(await lines(id)).toMatchObject([{ kind: "tax", quantity: 2, total: "0.00", exempt: true }]);
    await expect(page.getByText("Exonérée")).toBeVisible();

    await page.goto(`/admin/reservations/${id}/modifier`);
    await expect(page.getByLabel("Exonérer de la taxe de séjour")).toBeChecked();
    await page.getByLabel("Exonérer de la taxe de séjour").uncheck();
    await saveEdit(page, id);
    expect(await totalOf(id)).toBe("204.00");
    expect(await lines(id)).toMatchObject([{ kind: "tax", total: "4.00", exempt: false }]);
  });

  test("Fee + taxe : une ligne de chaque, total cohérent", async ({ page }) => {
    await setTax({ mode: "fixed", amount: 1 });
    await insertFee({ label: "Ménage", price: "30", unit: "per_stay" });
    await fillManual(page, { name: "Complet", checkIn: day(938), checkOut: day(940), guests: "3" });
    await page.fill('[name="childCount"]', "1");
    // 200 + 30 + 2 adultes × 2 nuits × 1 € = 234 €
    await expect(quote(page)).toContainText(/234\s€/);
    const id = await save(page);
    expect(await totalOf(id)).toBe("234.00");
    expect((await lines(id)).map((l) => l.kind)).toEqual(["fee", "tax"]);
  });
});

// ─── Export CSV (issue 03) ─────────────────────────────────────────────────────

async function insertStay(opts: {
  name: string;
  checkIn: number;
  checkOut: number;
  status?: string;
  guests?: number;
  children?: number;
  tax?: { total: string; exempt?: boolean };
  tenantId?: string;
  roomId?: string;
}) {
  const { rows } = await pool.query(
    `INSERT INTO bookings (tenant_id, room_id, check_in, check_out, total_price, status, guest_name, guest_email, guest_count, child_count, source)
     VALUES ($1, $2, $3, $4, '100.00', $5, $6, $7, $8, $9, 'manual') RETURNING id`,
    [
      opts.tenantId ?? ctx.tenantId,
      opts.roomId ?? familyRoomId,
      day(opts.checkIn),
      day(opts.checkOut),
      opts.status ?? "confirmed",
      `${opts.name} ${RUN_ID}`,
      `${RUN_ID}@${DOMAIN}`,
      opts.guests ?? 2,
      opts.children ?? 0,
    ],
  );
  if (opts.tax) {
    await pool.query(
      `INSERT INTO booking_lines (booking_id, kind, label, unit, unit_price, quantity, total, exempt)
       VALUES ($1, 'tax', 'Taxe de séjour', 'per_guest_night', '1.00', 2, $2, $3)`,
      [rows[0].id, opts.tax.total, opts.tax.exempt ?? false],
    );
  }
  return rows[0].id as string;
}

const fr = (n: number) => new Date(day(n) + "T00:00:00Z").toLocaleDateString("fr-FR", { timeZone: "UTC" });

test.describe("Admin — Export de la taxe de séjour", () => {
  test("période : confirmés et terminés seulement, départ dans la période, exonérés présents à 0 €, total en bas", async ({ page }) => {
    await insertStay({ name: "Confirmé", checkIn: 1000, checkOut: 1002, guests: 3, children: 1, tax: { total: "4.00" } });
    await insertStay({ name: "Terminé", checkIn: 1001, checkOut: 1003, status: "completed", tax: { total: "2.50" } });
    await insertStay({ name: "Exonéré", checkIn: 1002, checkOut: 1004, tax: { total: "0.00", exempt: true } });
    await insertStay({ name: "Annulé", checkIn: 1000, checkOut: 1002, status: "cancelled", tax: { total: "9.00" } });
    await insertStay({ name: "En attente", checkIn: 1000, checkOut: 1002, status: "pending", tax: { total: "9.00" } });
    await insertStay({ name: "Hors période", checkIn: 1004, checkOut: 1006, tax: { total: "9.00" } });
    // Arrivée avant la période, départ dedans : compté (filtre sur le départ).
    await insertStay({ name: "À cheval", checkIn: 995, checkOut: 1001, tax: { total: "1.00" } });

    const res = await page.request.get(`/api/admin/tourist-tax?from=${day(1001)}&to=${day(1004)}`);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/csv");
    expect(res.headers()["content-disposition"]).toContain(".csv");
    const body = await res.text();
    expect(body.charCodeAt(0)).toBe(0xfeff);
    const rows = body.slice(1).trim().split("\r\n").map((l) => l.split(";"));
    expect(rows[0]).toEqual(["Arrivée", "Départ", "Nuits", "Adultes", "Mineurs exonérés", "Exonération hôte", "Montant collecté (€)"]);
    expect(rows.slice(1)).toEqual([
      [fr(995), fr(1001), "6", "2", "0", "non", "1,00"],
      [fr(1000), fr(1002), "2", "2", "1", "non", "4,00"],
      [fr(1001), fr(1003), "2", "2", "0", "non", "2,50"],
      [fr(1002), fr(1004), "2", "2", "0", "oui", "0,00"],
      ["Total", "", "", "", "", "", "7,50"],
    ]);
  });

  test("période sans séjour : en-tête et total à 0", async ({ page }) => {
    const res = await page.request.get(`/api/admin/tourist-tax?from=${day(1100)}&to=${day(1101)}`);
    const rows = (await res.text()).slice(1).trim().split("\r\n");
    expect(rows).toHaveLength(2);
    expect(rows[1]).toBe("Total;;;;;;0,00");
  });

  test("période invalide → 400 propre, jamais 500", async ({ page }) => {
    for (const q of ["from=abc&to=2026-01-31", "from=2026-02-31&to=2026-03-01", "to=2026-01-31", "from=2026-03-01&to=2026-02-01", ""]) {
      const res = await page.request.get(`/api/admin/tourist-tax?${q}`);
      expect(res.status(), q).toBe(400);
      expect(await res.text()).toContain("Période invalide");
    }
  });

  test("isolation : les séjours d'un autre tenant n'apparaissent pas", async ({ page }) => {
    const { rows } = await pool.query("SELECT id FROM rooms WHERE tenant_id = $1 LIMIT 1", [ctx.rivalTenantId]);
    await insertStay({ name: "Rival", checkIn: 1200, checkOut: 1202, tenantId: ctx.rivalTenantId, roomId: rows[0].id, tax: { total: "9.00" } });
    const res = await page.request.get(`/api/admin/tourist-tax?from=${day(1202)}&to=${day(1202)}`);
    expect((await res.text()).slice(1).trim().split("\r\n")).toEqual([expect.stringContaining("Arrivée"), "Total;;;;;;0,00"]);
  });

  test("sans session → 401 (convention /api/admin du proxy), aucune donnée", async ({ browser }) => {
    const anon = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const res = await anon.request.get(`/api/admin/tourist-tax?from=${day(1000)}&to=${day(1004)}`);
    expect(res.status()).toBe(401);
    expect(await res.text()).not.toContain("Arrivée");
    await anon.close();
  });

  test("le formulaire d'export télécharge le CSV de la période choisie", async ({ page }) => {
    await insertStay({ name: "Formulaire", checkIn: 1300, checkOut: 1301, tax: { total: "3.30" } });
    await openSettings(page);
    const form = page.getByTestId("tourist-tax-export");
    await form.locator('[name="from"]').fill(day(1301));
    await form.locator('[name="to"]').fill(day(1301));
    const [download] = await Promise.all([page.waitForEvent("download"), form.getByRole("button", { name: "Exporter (CSV)" }).click()]);
    expect(download.suggestedFilename()).toBe(`taxe-de-sejour_${day(1301)}_${day(1301)}.csv`);
    const content = fs.readFileSync((await download.path())!, "utf-8");
    expect(content).toContain("3,30");
  });
});
