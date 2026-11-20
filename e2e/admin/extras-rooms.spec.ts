import { test, expect, type Page } from "@playwright/test";
import { fillAdminGuestName } from "../helpers/guest";
import fs from "fs";
import path from "path";
import { Pool } from "pg";
import { confirmDialog, SAVED_BOOKING_URL } from "../helpers/confirm";
import { deleteRoomsByName, insertHiddenRoom } from "../helpers/intake";

/**
 * Spécification : Tests de non-régression > Admin > Options par chambre
 * ADR-0010 : une option est proposée pour toutes les chambres, ou seulement celles
 * choisies dans le sélecteur des Règles (`RoomPicker`, `extras.room_ids`).
 *
 * Chambre API Test + une chambre « Suite » créée pour l'occasion. Séjours à
 * J+1400…J+1440. Tout porte TAG / `@extras-rooms.example`, supprimé en afterAll.
 */

const ctx = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "e2e", ".auth", "test-context.json"), "utf-8"),
) as { tenantId: string; apiRoomId: string; rivalTenantId: string };

const RUN_ID = Date.now().toString(36).slice(-6);
const TAG = `xr${RUN_ID}`;
const DOMAIN = "extras-rooms.example";
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const day = (n: number) => new Date(Date.now() + n * 86400000).toISOString().split("T")[0];

let suiteId = "";
let apiRoomName = "";

async function insertExtra(label: string, roomIds: string[] = []) {
  const { rows } = await pool.query(
    `INSERT INTO extras (tenant_id, label, price, unit, room_ids) VALUES ($1, $2, '10', 'per_stay', $3) RETURNING id`,
    [ctx.tenantId, `${label} ${TAG}`, roomIds],
  );
  return rows[0].id as string;
}

async function roomIdsOf(label: string) {
  const { rows } = await pool.query("SELECT room_ids FROM extras WHERE label = $1", [label]);
  return rows.map((r) => r.room_ids as string[]);
}

async function cleanup() {
  await pool.query("DELETE FROM bookings WHERE guest_email LIKE $1", [`%@${DOMAIN}`]);
  await pool.query("DELETE FROM extras WHERE label LIKE $1", [`%${TAG}%`]);
  await pool.query("DELETE FROM bookings WHERE room_id IN (SELECT id FROM rooms WHERE tenant_id = $1 AND slug ~ '-xr[0-9a-z]{6}$')", [ctx.tenantId]);
  await pool.query("DELETE FROM rooms WHERE tenant_id = $1 AND slug ~ '-xr[0-9a-z]{6}$'", [ctx.tenantId]);
}

test.beforeAll(async () => {
  await cleanup();
  const { rows } = await pool.query(
    `INSERT INTO rooms (tenant_id, property_id, name, slug, price_per_night, capacity)
     SELECT tenant_id, property_id, $1, $2, '100.00', 2 FROM rooms WHERE id = $3 RETURNING id`,
    [`Suite ${TAG}`, `suite-${TAG}`, ctx.apiRoomId],
  );
  suiteId = rows[0].id;
  apiRoomName = (await pool.query("SELECT name FROM rooms WHERE id = $1", [ctx.apiRoomId])).rows[0].name;
});
test.afterAll(async () => {
  await cleanup();
  await pool.end();
});

const section = (page: Page) =>
  page.locator("section").filter({ has: page.getByRole("heading", { name: "Options", exact: true }) });
const extraRow = (page: Page, label: string) => page.locator(`[data-testid="extra-row"][data-extra-label="${label}"]`);

async function startExtra(page: Page, label: string) {
  await page.goto("/admin/parametres?tab=etablissement");
  await section(page).getByRole("button", { name: "Ajouter", exact: true }).click();
  const form = page.getByTestId("extra-form");
  await form.locator('[name="label"]').fill(label);
  await form.locator('[name="price"]').fill("10");
  return form;
}

async function fillManual(page: Page, opts: { name: string; checkIn: string; checkOut: string; roomId: string }) {
  await page.goto("/admin/reservations/new");
  await page.locator('select[name="roomId"]').selectOption(opts.roomId);
  await fillAdminGuestName(page, `${opts.name} ${RUN_ID}`);
  await page.fill('[name="guestEmail"]', `${RUN_ID}@${DOMAIN}`);
  await page.fill('[name="guestCount"]', "1");
  await page.locator('[name="checkIn"]').fill(opts.checkIn);
  await page.locator('[name="checkOut"]').fill(opts.checkOut);
}

const pill = (page: Page, name: string) =>
  page.getByTestId("extra-form").getByTestId("room-picker").getByRole("button", { name, exact: true });

test.describe("Admin — Options par chambre (catalogue)", () => {
  test("par défaut : « Toutes les chambres » sélectionné, room_ids vide, ligne « Toutes les chambres »", async ({ page }) => {
    const label = `Partout ${TAG}`;
    const form = await startExtra(page, label);
    await expect(pill(page, "Toutes les chambres")).toHaveAttribute("aria-pressed", "true");
    await expect(pill(page, `Suite ${TAG}`)).toHaveAttribute("aria-pressed", "false");
    await form.getByRole("button", { name: "Ajouter l'option" }).click();
    await expect(extraRow(page, label).getByTestId("extra-rooms")).toHaveText("Toutes les chambres");
    expect(await roomIdsOf(label)).toEqual([[]]);
  });

  test("une chambre choisie → enregistrée et affichée ; ajout d'une 2e ; « Toutes les chambres » → vidé", async ({ page }) => {
    const label = `Spa ${TAG}`;
    const form = await startExtra(page, label);
    await pill(page, `Suite ${TAG}`).click();
    await expect(pill(page, "Toutes les chambres")).toHaveAttribute("aria-pressed", "false");
    await form.getByRole("button", { name: "Ajouter l'option" }).click();
    await expect(extraRow(page, label).getByTestId("extra-rooms")).toHaveText(`Suite ${TAG}`);
    expect(await roomIdsOf(label)).toEqual([[suiteId]]);

    // Modifier : la sélection est reprise.
    await extraRow(page, label).getByRole("button", { name: "Modifier" }).click();
    await expect(pill(page, `Suite ${TAG}`)).toHaveAttribute("aria-pressed", "true");
    await pill(page, apiRoomName).click();
    await page.getByTestId("extra-form").getByRole("button", { name: "Enregistrer l'option" }).click();
    await expect(extraRow(page, label).getByTestId("extra-rooms")).toContainText(`Suite ${TAG}`);
    expect((await roomIdsOf(label))[0].sort()).toEqual([ctx.apiRoomId, suiteId].sort());

    // « Toutes les chambres » : la sélection est vidée.
    await extraRow(page, label).getByRole("button", { name: "Modifier" }).click();
    await pill(page, "Toutes les chambres").click();
    await page.getByTestId("extra-form").getByRole("button", { name: "Enregistrer l'option" }).click();
    // Formulaire ouvert = pas de ligne : attendre la ligne avant de la lire.
    await expect(extraRow(page, label).getByTestId("extra-rooms")).toHaveText("Toutes les chambres");
    expect(await roomIdsOf(label)).toEqual([[]]);
  });

  test("dernière chambre désélectionnée → repasse à « Toutes les chambres »", async ({ page }) => {
    const label = `Retour ${TAG}`;
    const form = await startExtra(page, label);
    await pill(page, `Suite ${TAG}`).click();
    await pill(page, `Suite ${TAG}`).click();
    await expect(pill(page, "Toutes les chambres")).toHaveAttribute("aria-pressed", "true");
    await form.getByRole("button", { name: "Ajouter l'option" }).click();
    await expect(extraRow(page, label)).toBeVisible();
    expect(await roomIdsOf(label)).toEqual([[]]);
  });

  test("chambres forgées seules (autre tenant, inexistante, mal formée) : refusé, jamais « toutes » ; avec une vraie : seule celle-ci gardée", async ({ page }) => {
    const { rows } = await pool.query("SELECT id FROM rooms WHERE tenant_id = $1 LIMIT 1", [ctx.rivalTenantId]);
    const forged = [rows[0]?.id ?? "00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000000", "pas-un-uuid"];
    const label = `Forgé ${TAG}`;
    const form = await startExtra(page, label);
    await form.evaluate((f: HTMLFormElement, ids) => {
      for (const id of ids) {
        const i = document.createElement("input");
        i.type = "hidden";
        i.name = "roomIds";
        i.value = id;
        f.appendChild(i);
      }
    }, forged);
    await form.getByRole("button", { name: "Ajouter l'option" }).click();
    await expect(form.getByText("Les chambres choisies n'existent plus. Rechargez la page.").first()).toBeVisible();
    expect(await roomIdsOf(label)).toEqual([]);

    await pill(page, `Suite ${TAG}`).click();
    await form.getByRole("button", { name: "Ajouter l'option" }).click();
    await expect(extraRow(page, label)).toBeVisible();
    expect(await roomIdsOf(label)).toEqual([[suiteId]]);
  });

  test("XSS dans le nom d'une chambre : affiché échappé dans la liste, aucun dialog", async ({ page }) => {
    let dialog = false;
    page.on("dialog", (d) => {
      dialog = true;
      void d.dismiss();
    });
    const { rows } = await pool.query(
      `INSERT INTO rooms (tenant_id, property_id, name, slug, price_per_night, capacity)
       SELECT tenant_id, property_id, $1, $2, '100.00', 2 FROM rooms WHERE id = $3 RETURNING id`,
      [`<img src=x onerror=alert(1)> ${TAG}`, `xss-${TAG}`, ctx.apiRoomId],
    );
    const label = `Xss ${TAG}`;
    await insertExtra("Xss", [rows[0].id]);
    await page.goto("/admin/parametres?tab=etablissement");
    await expect(extraRow(page, label).getByTestId("extra-rooms")).toContainText("<img src=x onerror=alert(1)>");
    expect(dialog).toBe(false);
  });
});

test.describe("Admin — Réservation manuelle avec option par chambre", () => {
  test("option de la Suite : absente sur l'autre chambre, apparaît en passant à la Suite", async ({ page }) => {
    await insertExtra("Jacuzzi", [suiteId]);
    await insertExtra("Linge");
    await fillManual(page, { name: "Bascule", checkIn: day(1400), checkOut: day(1401), roomId: ctx.apiRoomId });
    await expect(page.getByLabel(`Linge ${TAG}`)).toBeVisible();
    await expect(page.getByText(`Jacuzzi ${TAG}`)).toHaveCount(0);
    await page.locator('select[name="roomId"]').selectOption(suiteId);
    await page.getByLabel(`Jacuzzi ${TAG}`).check();
    // Coché puis retour sur l'autre chambre : la case disparaît, rien n'est enregistré.
    await page.locator('select[name="roomId"]').selectOption(ctx.apiRoomId);
    await expect(page.getByText(`Jacuzzi ${TAG}`)).toHaveCount(0);
    await page.click('[type="submit"]');
    await expect(page).toHaveURL(SAVED_BOOKING_URL);
    const id = page.url().match(/reservations\/([0-9a-f-]{36})/)![1];
    expect((await pool.query("SELECT 1 FROM booking_lines WHERE booking_id = $1", [id])).rowCount).toBe(0);
  });

  test("option de la Suite injectée sur l'autre chambre : refusée, rien en base", async ({ page }) => {
    const extraId = await insertExtra("Ailleurs", [suiteId]);
    await fillManual(page, { name: "Injecté", checkIn: day(1404), checkOut: day(1405), roomId: ctx.apiRoomId });
    await page.locator("form").evaluate((f: HTMLFormElement, v) => {
      const i = document.createElement("input");
      i.type = "hidden";
      i.name = "extraIds";
      i.value = v;
      f.appendChild(i);
    }, extraId);
    await page.click('[type="submit"]');
    await expect(page.getByText(/pas proposée pour cette chambre/)).toBeVisible();
    expect((await pool.query("SELECT 1 FROM bookings WHERE guest_name = $1", [`Injecté ${RUN_ID}`])).rowCount).toBe(0);
  });

  test("option restreinte après coup : la réservation existante la garde, même modifiée", async ({ page }) => {
    const extraId = await insertExtra("Panier");
    await fillManual(page, { name: "Ancienne", checkIn: day(1408), checkOut: day(1409), roomId: ctx.apiRoomId });
    await page.getByLabel(`Panier ${TAG}`).check();
    await page.click('[type="submit"]');
    await expect(page).toHaveURL(SAVED_BOOKING_URL);
    const id = page.url().match(/reservations\/([0-9a-f-]{36})/)![1];

    await pool.query("UPDATE extras SET room_ids = $1 WHERE id = $2", [[suiteId], extraId]);
    await page.goto(`/admin/reservations/${id}/modifier`);
    await expect(page.getByLabel(`Panier ${TAG}`)).toBeChecked();
    await page.locator('[name="checkOut"]').fill(day(1410));
    await page.locator('[name="notifyGuest"]').uncheck();
    await page.getByRole("button", { name: "Enregistrer les modifications" }).click();
    await expect(page).toHaveURL(`/admin/reservations/${id}?modifiee=silence`);
    const { rows } = await pool.query("SELECT label FROM booking_lines WHERE booking_id = $1 AND kind = 'extra'", [id]);
    expect(rows).toEqual([{ label: `Panier ${TAG}` }]);
  });
});

test.describe("Admin — Suppression d'une chambre", () => {
  test("retirée des options qui la visent ; une option qui ne visait qu'elle est supprimée, jamais « toutes »", async ({ page }) => {
    const GONE = `Chambre Options Supprimée ${TAG}`;
    const goneId = await insertHiddenRoom(ctx.tenantId, GONE);
    try {
      await insertExtra("Seule", [goneId]);
      await insertExtra("Partagée", [goneId, suiteId]);

      await page.goto("/admin/chambres");
      const card = page.locator(`xpath=//div[.//div[normalize-space()="${GONE}"]][.//button[normalize-space()="Supprimer"]]`).last();
      await card.getByRole("button", { name: "Supprimer", exact: true }).click();
      await confirmDialog(page);
      await expect(page.getByText(GONE, { exact: true })).toHaveCount(0);

      expect(await roomIdsOf(`Seule ${TAG}`)).toEqual([]);
      expect(await roomIdsOf(`Partagée ${TAG}`)).toEqual([[suiteId]]);
    } finally {
      await deleteRoomsByName(ctx.tenantId, GONE);
    }
  });
});
