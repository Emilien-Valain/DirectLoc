import { test, expect, type Page } from "@playwright/test";
import { fillAdminGuestName } from "../helpers/guest";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { Pool } from "pg";
import { deleteOrphanDossiers } from "../helpers/dossier";
import { confirmDialog, SAVED_BOOKING_URL } from "../helpers/confirm";
import { startSmtpSink } from "../helpers/smtp-sink";

/**
 * Spécification : Tests de non-régression > Admin > Extras (options payantes)
 * Issues .scratch/extras/01, 03, 04, 05 — ADR-0010.
 *
 * Catalogue géré dans Paramètres > Mon établissement ; Extras figés sur la
 * réservation ; reste à payer ; Extras dans le PDF et l'email de confirmation.
 * Chambre API Test (100 €/nuit, 2 pers.), séjours à J+700…J+799, un créneau par test (aucune autre
 * fixture) ; tout porte RUN_ID / `@extras.example` et est supprimé en afterAll.
 */

const ctx = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "e2e", ".auth", "test-context.json"), "utf-8"),
) as { tenantId: string; apiRoomId: string; rivalTenantId: string };

const RUN_ID = Date.now().toString(36).slice(-6);
const DOMAIN = "extras.example";
const TAG = `xt${RUN_ID}`;
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });

const day = (n: number) => new Date(Date.now() + n * 86400000).toISOString().split("T")[0];

async function insertExtra(opts: { label: string; price: string; unit: string; active?: boolean; tenantId?: string; maxQuantity?: number }) {
  const { rows } = await pool.query(
    `INSERT INTO extras (tenant_id, label, price, unit, active, max_quantity) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [opts.tenantId ?? ctx.tenantId, `${opts.label} ${TAG}`, opts.price, opts.unit, opts.active ?? true, opts.maxQuantity ?? null],
  );
  return rows[0].id as string;
}

async function insertBooking(opts: {
  name: string;
  checkIn: string;
  checkOut: string;
  total: string;
  status?: string;
  source?: string;
  guests?: number;
}) {
  const { rows } = await pool.query(
    `WITH d AS (INSERT INTO dossiers (tenant_id, check_in, check_out, guest_name, guest_email) VALUES ($1, '2030-01-01', '2030-01-02', 'Dossier Test', 'dossier@example.com') RETURNING id)
     INSERT INTO bookings (tenant_id, room_id, check_in, check_out, total_price, status, guest_name, guest_email, guest_count, source, dossier_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, (SELECT id FROM d)) RETURNING id`,
    [
      ctx.tenantId,
      ctx.apiRoomId,
      opts.checkIn,
      opts.checkOut,
      opts.total,
      opts.status ?? "confirmed",
      `${opts.name} ${RUN_ID}`,
      `${RUN_ID}@${DOMAIN}`,
      opts.guests ?? 1,
      opts.source ?? "manual",
    ],
  );
  return rows[0].id as string;
}

async function lines(bookingId: string) {
  const { rows } = await pool.query(
    "SELECT source_id, label, unit_price, quantity, total FROM booking_lines WHERE booking_id = $1 ORDER BY created_at, label",
    [bookingId],
  );
  return rows as { source_id: string | null; label: string; unit_price: string; quantity: number; total: string }[];
}

async function totalOf(bookingId: string) {
  const { rows } = await pool.query("SELECT total_price FROM bookings WHERE id = $1", [bookingId]);
  return rows[0].total_price as string;
}

async function cleanup() {
  await pool.query(
    "DELETE FROM payments WHERE dossier_id IN (SELECT dossier_id FROM bookings WHERE guest_email LIKE $1)",
    [`%@${DOMAIN}`],
  );
  // booking_lines suit en cascade.
  await pool.query("DELETE FROM bookings WHERE guest_email LIKE $1", [`%@${DOMAIN}`]);
  await deleteOrphanDossiers(pool);
  await pool.query("DELETE FROM extras WHERE label LIKE $1", [`%${TAG}%`]);
}

test.beforeAll(cleanup);
test.afterAll(async () => {
  await cleanup();
  await pool.end();
});

async function openOptions(page: Page) {
  await page.goto("/admin/parametres?tab=etablissement");
  await expect(page.getByRole("heading", { name: "Options", exact: true })).toBeVisible();
}

const section = (page: Page) =>
  page.locator("section").filter({ has: page.getByRole("heading", { name: "Options", exact: true }) });

async function addExtra(page: Page, label: string, price: string, unit = "per_stay") {
  await section(page).getByRole("button", { name: "Ajouter", exact: true }).click();
  const form = page.getByTestId("extra-form");
  await form.locator('[name="label"]').fill(label);
  await form.locator('[name="price"]').fill(price);
  await form.locator('[name="unit"]').selectOption(unit);
  await form.getByRole("button", { name: "Ajouter l'option" }).click();
}

const row = (page: Page, label: string) => page.locator(`[data-testid="extra-row"][data-extra-label="${label}"]`);

// ─── Catalogue (issue 01) ──────────────────────────────────────────────────────

test.describe("Admin — Catalogue d'Extras", () => {
  test("créer, modifier, désactiver, réactiver, supprimer", async ({ page }) => {
    const label = `Petit-déjeuner ${TAG}`;
    await openOptions(page);
    await addExtra(page, label, "12,50", "per_guest_night");
    await expect(row(page, label)).toContainText("12,50 € par personne et par nuit");

    await row(page, label).getByRole("button", { name: "Modifier" }).click();
    await page.getByTestId("extra-form").locator('[name="price"]').fill("14");
    await page.getByRole("button", { name: "Enregistrer l'option" }).click();
    await expect(row(page, label)).toContainText("14 € par personne et par nuit");

    await row(page, label).getByRole("button", { name: "Désactiver" }).click();
    await expect(row(page, label)).toContainText("Désactivée");
    const { rows } = await pool.query("SELECT active FROM extras WHERE label = $1", [label]);
    expect(rows[0].active).toBe(false);
    await row(page, label).getByRole("button", { name: "Activer" }).click();
    await expect(row(page, label)).not.toContainText("Désactivée");

    await row(page, label).getByRole("button", { name: "Supprimer" }).click();
    await confirmDialog(page);
    await expect(row(page, label)).toHaveCount(0);
    expect((await pool.query("SELECT 1 FROM extras WHERE label = $1", [label])).rowCount).toBe(0);
  });

  test("limite : prix 0 accepté (option gratuite)", async ({ page }) => {
    const label = `Lit bébé ${TAG}`;
    await openOptions(page);
    await addExtra(page, label, "0");
    await expect(row(page, label)).toContainText("Gratuit");
  });

  test("prix négatif, prix invalide et libellé vide refusés, rien en base", async ({ page }) => {
    await openOptions(page);
    await section(page).getByRole("button", { name: "Ajouter", exact: true }).click();
    const form = page.getByTestId("extra-form");
    await form.evaluate((f: HTMLFormElement) => (f.noValidate = true));

    await form.locator('[name="label"]').fill(`Négatif ${TAG}`);
    await form.locator('[name="price"]').fill("-5");
    await form.getByRole("button", { name: "Ajouter l'option" }).click();
    await expect(form.locator('[name="price"]')).toHaveAttribute("aria-invalid", "true");

    await form.locator('[name="price"]').fill("abc");
    await form.getByRole("button", { name: "Ajouter l'option" }).click();
    await expect(form.getByText(/montant positif ou nul/).first()).toBeVisible();

    await form.locator('[name="label"]').fill("   ");
    await form.locator('[name="price"]').fill("5");
    await form.getByRole("button", { name: "Ajouter l'option" }).click();
    await expect(form.locator('[name="label"]')).toHaveAttribute("aria-invalid", "true");

    expect((await pool.query("SELECT 1 FROM extras WHERE label LIKE $1", [`Négatif ${TAG}%`])).rowCount).toBe(0);
  });

  test("limite : libellé de 500 caractères accepté, 501 refusé", async ({ page }) => {
    await openOptions(page);
    const long = (TAG + "a".repeat(500)).slice(0, 500);
    await addExtra(page, long, "3");
    await expect(row(page, long)).toBeVisible();

    await section(page).getByRole("button", { name: "Ajouter", exact: true }).click();
    const form = page.getByTestId("extra-form");
    await form.locator('[name="label"]').evaluate((i: HTMLInputElement) => i.removeAttribute("maxlength"));
    await form.locator('[name="label"]').fill(long + "b");
    await form.locator('[name="price"]').fill("3");
    await form.getByRole("button", { name: "Ajouter l'option" }).click();
    await expect(form.getByText(/500 caractères max/).first()).toBeVisible();
  });

  test("XSS dans le libellé : affiché échappé, aucun dialog", async ({ page }) => {
    let dialog = false;
    page.on("dialog", (d) => {
      dialog = true;
      void d.dismiss();
    });
    const label = `<script>alert(1)</script> ${TAG}`;
    await openOptions(page);
    await addExtra(page, label, "1");
    await expect(row(page, label)).toContainText("<script>alert(1)</script>");
    expect(dialog).toBe(false);
  });

  test("isolation : un Extra d'un autre tenant n'apparaît pas", async ({ page }) => {
    await insertExtra({ label: "Rival", price: "9", unit: "per_stay", tenantId: ctx.rivalTenantId });
    await openOptions(page);
    await expect(page.getByText(`Rival ${TAG}`)).toHaveCount(0);
  });
});

// ─── Réservation manuelle (issue 03) ───────────────────────────────────────────

async function fillManual(page: Page, opts: { name: string; checkIn: string; checkOut: string; guests?: string }) {
  await page.goto("/admin/reservations/new");
  await page.locator('select[name="roomId"]').selectOption(ctx.apiRoomId);
  await fillAdminGuestName(page, `${opts.name} ${RUN_ID}`);
  await page.fill('[name="guestEmail"]', `${RUN_ID}@${DOMAIN}`);
  await page.fill('[name="guestCount"]', opts.guests ?? "1");
  await page.locator('[name="checkIn"]').fill(opts.checkIn);
  await page.locator('[name="checkOut"]').fill(opts.checkOut);
}

const quote = (page: Page) => page.locator('[aria-live="polite"]').first();

async function saveEdit(page: Page, id: string) {
  await page.locator('[name="notifyGuest"]').uncheck();
  await page.getByRole("button", { name: "Enregistrer les modifications" }).click();
  await expect(page).toHaveURL(`/admin/reservations/${id}?modifiee=silence`);
}

test.describe("Admin — Réservation manuelle avec Extras", () => {
  test("création : Extra coché → ligne figée, total = hébergement + Extra, détail affiché", async ({ page }) => {
    const sourceId = await insertExtra({ label: "Draps", price: "7.50", unit: "per_guest_night" });
    await fillManual(page, { name: "Manuel Extra", checkIn: day(700), checkOut: day(702), guests: "2" });
    await page.getByLabel(`Draps ${TAG}`).check();
    // 2 nuits × 100 € + 2 nuits × 2 pers. × 7,50 € = 230 €
    await expect(quote(page)).toContainText(/230\s€/);
    await page.click('[type="submit"]');
    await expect(page).toHaveURL(SAVED_BOOKING_URL);
    const id = page.url().match(/reservations\/([0-9a-f-]{36})/)![1];

    expect(await totalOf(id)).toBe("230.00");
    expect(await lines(id)).toEqual([
      { source_id: sourceId, label: `Draps ${TAG}`, unit_price: "7.50", quantity: 4, total: "30.00" },
    ]);
    await expect(page.getByText(`Draps ${TAG} (4 × 7,50 €)`)).toBeVisible();
    await expect(page.getByText("Hébergement")).toBeVisible();
  });

  test("aucun Extra coché : flux inchangé, aucune ligne", async ({ page }) => {
    await insertExtra({ label: "Ignoré", price: "5", unit: "per_stay" });
    await fillManual(page, { name: "Sans Extra", checkIn: day(704), checkOut: day(705) });
    await expect(quote(page)).toContainText(/100\s€/);
    await page.click('[type="submit"]');
    await expect(page).toHaveURL(SAVED_BOOKING_URL);
    const id = page.url().match(/reservations\/([0-9a-f-]{36})/)![1];
    expect(await totalOf(id)).toBe("100.00");
    expect(await lines(id)).toEqual([]);
  });

  test("prix convenu = hébergement seul : total = prix convenu + Extras", async ({ page }) => {
    await insertExtra({ label: "Ménage fin", price: "40", unit: "per_stay" });
    await fillManual(page, { name: "Convenu", checkIn: day(708), checkOut: day(711) });
    await page.getByLabel(`Ménage fin ${TAG}`).check();
    await page.fill('[name="agreedPrice"]', "250");
    await page.click('[type="submit"]');
    await expect(page).toHaveURL(SAVED_BOOKING_URL);
    const id = page.url().match(/reservations\/([0-9a-f-]{36})/)![1];
    expect(await totalOf(id)).toBe("290.00");
  });

  test("Extra inactif ou d'un autre tenant injecté : refusé, rien en base", async ({ page }) => {
    const inactive = await insertExtra({ label: "Inactif", price: "5", unit: "per_stay", active: false });
    const rival = await insertExtra({ label: "Autre", price: "5", unit: "per_stay", tenantId: ctx.rivalTenantId });
    for (const id of [inactive, rival, "pas-un-uuid"]) {
      await fillManual(page, { name: `Injecté ${id.slice(0, 4)}`, checkIn: day(714), checkOut: day(715) });
      await page.locator("form").evaluate((f: HTMLFormElement, v) => {
        const i = document.createElement("input");
        i.type = "hidden";
        i.name = "extraIds";
        i.value = v;
        f.appendChild(i);
      }, id);
      await page.click('[type="submit"]');
      await expect(page.getByText(/option cochée vient d.être désactivée/)).toBeVisible();
    }
    const { rowCount } = await pool.query(
      "SELECT 1 FROM bookings WHERE guest_email = $1 AND guest_name LIKE 'Injecté%'",
      [`${RUN_ID}@${DOMAIN}`],
    );
    expect(rowCount).toBe(0);
  });

  test("modification : 3 → 5 nuits recalcule au prix figé, même après un changement de prix catalogue", async ({ page }) => {
    const sourceId = await insertExtra({ label: "Petit-déj", price: "10", unit: "per_night" });
    await fillManual(page, { name: "Allonge", checkIn: day(720), checkOut: day(723) });
    await page.getByLabel(`Petit-déj ${TAG}`).check();
    await page.click('[type="submit"]');
    await expect(page).toHaveURL(SAVED_BOOKING_URL);
    const id = page.url().match(/reservations\/([0-9a-f-]{36})/)![1];
    expect(await totalOf(id)).toBe("330.00");

    // Le catalogue change : la réservation n'est pas touchée…
    await pool.query("UPDATE extras SET price = '99' WHERE id = $1", [sourceId]);
    expect(await totalOf(id)).toBe("330.00");

    // …et l'allonger recalcule la quantité au prix figé (10 €), pas au nouveau (99 €).
    await page.goto(`/admin/reservations/${id}/modifier`);
    await expect(page.getByLabel(`Petit-déj ${TAG}`)).toBeChecked();
    await page.locator('[name="checkOut"]').fill(day(725));
    await expect(quote(page)).toContainText("5 nuits");
    await expect(quote(page)).toContainText(/550\s€/);
    await saveEdit(page, id);
    expect(await totalOf(id)).toBe("550.00");
    expect((await lines(id))[0]).toMatchObject({ unit_price: "10.00", quantity: 5, total: "50.00" });
  });

  test("décocher puis recocher : nouvelle ligne au prix catalogue actuel", async ({ page }) => {
    const sourceId = await insertExtra({ label: "Serviettes", price: "5", unit: "per_stay" });
    const id = await insertBooking({ name: "Recoche", checkIn: day(730), checkOut: day(732), total: "205.00" });
    await pool.query(
      `INSERT INTO booking_lines (booking_id, kind, source_id, label, unit, unit_price, quantity, total)
       VALUES ($1, 'extra', $2, $3, 'per_stay', '5.00', 1, '5.00')`,
      [id, sourceId, `Serviettes ${TAG}`],
    );
    await pool.query("UPDATE extras SET price = '8' WHERE id = $1", [sourceId]);

    await page.goto(`/admin/reservations/${id}/modifier`);
    await page.getByLabel(`Serviettes ${TAG}`).uncheck();
    await saveEdit(page, id);
    expect(await lines(id)).toEqual([]);
    expect(await totalOf(id)).toBe("200.00");

    await page.goto(`/admin/reservations/${id}/modifier`);
    await page.getByLabel(`Serviettes ${TAG}`).check();
    await saveEdit(page, id);
    expect((await lines(id))[0]).toMatchObject({ unit_price: "8.00", total: "8.00" });
    expect(await totalOf(id)).toBe("208.00");
  });

  test("Extra désactivé (ou supprimé) déjà sur la réservation : conservé et affiché", async ({ page }) => {
    const sourceId = await insertExtra({ label: "Vélo", price: "15", unit: "per_night" });
    const id = await insertBooking({ name: "Garde Vélo", checkIn: day(740), checkOut: day(742), total: "230.00" });
    await pool.query(
      `INSERT INTO booking_lines (booking_id, kind, source_id, label, unit, unit_price, quantity, total)
       VALUES ($1, 'extra', $2, $3, 'per_night', '15.00', 2, '30.00')`,
      [id, sourceId, `Vélo ${TAG}`],
    );
    await pool.query("UPDATE extras SET active = false WHERE id = $1", [sourceId]);

    await page.goto(`/admin/reservations/${id}/modifier`);
    await expect(page.getByLabel(`Vélo ${TAG}`)).toBeChecked();
    await page.locator('[name="checkOut"]').fill(day(743));
    await saveEdit(page, id);
    expect((await lines(id))[0]).toMatchObject({ quantity: 3, total: "45.00" });

    // Supprimé du catalogue : la copie reste (source_id orphelin, sans FK) et se garde à l'édition suivante.
    await pool.query("DELETE FROM extras WHERE id = $1", [sourceId]);
    await page.goto(`/admin/reservations/${id}/modifier`);
    await expect(page.getByLabel(`Vélo ${TAG}`)).toBeChecked();
    await saveEdit(page, id);
    expect((await lines(id))[0]).toMatchObject({ source_id: sourceId, quantity: 3, total: "45.00" });
    expect(await totalOf(id)).toBe("345.00");
  });

  test("modifier les Extras ne touche pas aux lignes fee/tax (ADR-0011)", async ({ page }) => {
    await insertExtra({ label: "Bouquet", price: "12", unit: "per_stay" });
    const id = await insertBooking({ name: "Garde Fee", checkIn: day(750), checkOut: day(752), total: "225.00" });
    await addLine(id, `Ménage ${TAG}`, { kind: "fee", unit: "per_stay", unitPrice: "25.00", quantity: 1, total: "25.00" });

    await page.goto(`/admin/reservations/${id}`);
    await expect(page.getByText(`Ménage ${TAG}`)).toBeVisible();

    await page.goto(`/admin/reservations/${id}/modifier`);
    // Un Fee n'est pas une case « Options ».
    await expect(page.getByTestId("manual-extras").getByText(`Ménage ${TAG}`)).toHaveCount(0);
    await page.getByLabel(`Bouquet ${TAG}`).check();
    await saveEdit(page, id);
    const { rows } = await pool.query("SELECT kind, label FROM booking_lines WHERE booking_id = $1 ORDER BY kind", [id]);
    expect(rows).toEqual([
      { kind: "extra", label: `Bouquet ${TAG}` },
      { kind: "fee", label: `Ménage ${TAG}` },
    ]);
    // 2 nuits × 100 € + Bouquet 12 € + Ménage 25 € (ligne gardée telle quelle)
    expect(await totalOf(id)).toBe("237.00");
  });

  test("« Garder l'ancien prix » garde l'hébergement, les Extras s'ajoutent", async ({ page }) => {
    await insertExtra({ label: "Panier", price: "20", unit: "per_stay" });
    const id = await insertBooking({ name: "Garde Héb", checkIn: day(746), checkOut: day(748), total: "180.00" });
    await page.goto(`/admin/reservations/${id}/modifier`);
    await page.getByLabel(`Panier ${TAG}`).check();
    await page.locator('[name="checkOut"]').fill(day(749));
    await expect(quote(page)).toContainText("3 nuits");
    await page.getByLabel(/Garder l.ancien prix de l.hébergement \(180\s€\)/).check();
    await saveEdit(page, id);
    expect(await totalOf(id)).toBe("200.00");
  });
});

// ─── Reste à payer (issue 04) ──────────────────────────────────────────────────

test.describe("Admin — Reste à payer", () => {
  test("résa payée en ligne + Extra ajouté : reste affiché ; « Marquer réglé » → reste 0 ; aucun remboursement", async ({ page }) => {
    await insertExtra({ label: "Late checkout", price: "30", unit: "per_stay" });
    const id = await insertBooking({ name: "Payé", checkIn: day(760), checkOut: day(762), total: "200.00", source: "direct" });
    await pool.query(
      `INSERT INTO payments (tenant_id, dossier_id, stripe_session_id, amount, currency, status, created_at)
       VALUES ($1, (SELECT dossier_id FROM bookings WHERE id = $2), $3, '200.00', 'eur', 'paid', now() - interval '2 hours')`,
      [ctx.tenantId, id, `cs_extras_${id}`],
    );

    // Directe payée : modifiable (pas de checkout ouvert).
    await page.goto(`/admin/reservations/${id}/modifier`);
    await page.getByLabel(`Late checkout ${TAG}`).check();
    await expect(page.locator("[data-paid-difference]")).toContainText(/\+30\s€/);
    await saveEdit(page, id);

    await expect(page.locator("[data-balance-due]")).toContainText(/Payé 200\s€ en ligne · reste 30\s€/);
    // La note d'annulation parle toujours du montant réellement payé.
    await page.getByRole("button", { name: "Annuler la réservation" }).click();
    await expect(page.locator("dialog[open] [data-refund-note]")).toContainText(/a payé 200\s€ en ligne/);
    await page.locator("dialog[open]").getByRole("button", { name: "Garder" }).click();

    await page.locator("[data-balance-due]").getByRole("button", { name: "Marquer réglé" }).click();
    await expect(page.locator("[data-balance-due]")).toHaveCount(0);
    await expect(page.getByText(/Réglé le/)).toBeVisible();

    const { rows } = await pool.query("SELECT status, amount FROM payments WHERE dossier_id = (SELECT dossier_id FROM bookings WHERE id = $1)", [id]);
    expect(rows).toEqual([{ status: "paid", amount: "200.00" }]);
  });

  test("saisie manuelle non payée en ligne : pas de « reste », juste « À régler »", async ({ page }) => {
    const id = await insertBooking({ name: "Pas en ligne", checkIn: day(766), checkOut: day(767), total: "100.00" });
    await page.goto(`/admin/reservations/${id}`);
    await expect(page.locator("[data-balance-due]")).toHaveCount(0);
    await expect(page.getByText("À régler avec le client")).toBeVisible();
  });
});

// ─── PDF et email (issue 05) ───────────────────────────────────────────────────

async function addLine(
  bookingId: string,
  label: string,
  opts: { kind?: string; unit: string; unitPrice: string; quantity: number; total: string } = {
    unit: "per_guest_night",
    unitPrice: "9.00",
    quantity: 4,
    total: "36.00",
  },
) {
  await pool.query(
    `INSERT INTO booking_lines (booking_id, kind, label, unit, unit_price, quantity, total) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [bookingId, opts.kind ?? "extra", label, opts.unit, opts.unitPrice, opts.quantity, opts.total],
  );
}

test.describe("Admin — Extras dans le PDF et les emails", () => {
  test("PDF généré sans erreur avec Extras, même libellé hors Latin-1 (emoji)", async ({ page }) => {
    const id = await insertBooking({ name: "PDF", checkIn: day(770), checkOut: day(772), total: "236.00", guests: 2 });
    await addLine(id, `☕ Petit-déjeuner ${TAG}`);
    const res = await page.request.get(`/api/admin/reservations/${id}/pdf`);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("application/pdf");
    expect((await res.body()).subarray(0, 4).toString()).toBe("%PDF");
  });

  test("email de confirmation (webhook payé) : contient la ligne Extra, libellé échappé", async ({ page }) => {
    const id = await insertBooking({
      name: "Mail",
      checkIn: day(780),
      checkOut: day(782),
      total: "236.00",
      status: "pending",
      source: "direct",
      guests: 2,
    });
    await addLine(id, `Breakfast <b>${TAG}</b>`);
    // ADR-0011 : l'email liste toutes les booking_lines, pas seulement les Extras.
    await addLine(id, `Cleaning ${TAG}`, { kind: "fee", unit: "per_stay", unitPrice: "25.00", quantity: 1, total: "25.00" });
    const sessionId = `cs_extras_mail_${id}`;
    await pool.query(
      `INSERT INTO payments (tenant_id, dossier_id, stripe_session_id, amount, currency, status)
       VALUES ($1, (SELECT dossier_id FROM bookings WHERE id = $2), $3, '236.00', 'eur', 'pending')`,
      [ctx.tenantId, id, sessionId],
    );

    const sink = await startSmtpSink();
    try {
      const payload = JSON.stringify({
        id: `evt_extras_${Date.now()}`,
        type: "checkout.session.completed",
        data: { object: { id: sessionId, payment_intent: `pi_extras_${Date.now()}`, metadata: { bookingId: id, tenantId: ctx.tenantId } } },
      });
      const ts = Math.floor(Date.now() / 1000);
      const sig = crypto
        .createHmac("sha256", process.env.STRIPE_WEBHOOK_SECRET ?? "whsec_test_XXXX")
        .update(`${ts}.${payload}`)
        .digest("hex");
      const res = await page.request.post("/api/webhooks/stripe", {
        data: payload,
        headers: { "content-type": "application/json", "stripe-signature": `t=${ts},v1=${sig}` },
      });
      expect(res.status()).toBe(200);

      const guestMail = () => sink.mails.find((m) => m.to.includes(`${RUN_ID}@${DOMAIN}`));
      await expect.poll(() => !!guestMail(), { timeout: 10_000 }).toBe(true);
      // Corps en quoted-printable : on recolle les lignes coupées et on décode les =XX.
      const body = guestMail()!
        .raw.replace(/=\r\n/g, "")
        .replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
      expect(body).toContain(`Breakfast &lt;b&gt;${TAG}&lt;/b&gt;`);
      expect(body).not.toContain(`<b>${TAG}</b>`);
      expect(body).toContain("36,00");
      expect(body).toContain(`Cleaning ${TAG}`);
    } finally {
      await sink.stop();
    }
  });
});

// ─── Options « par lit » : quantité choisie, bornée aux lits ─────────────────────

test.describe("Admin — Option par lit (draps)", () => {
  test.beforeAll(async () => {
    await pool.query("UPDATE rooms SET beds = 3 WHERE id = $1", [ctx.apiRoomId]);
  });
  test.afterAll(async () => {
    await pool.query("UPDATE rooms SET beds = NULL WHERE id = $1", [ctx.apiRoomId]);
  });

  test("catalogue : unité « par lit » proposée pour une option, pas pour un frais", async ({ page }) => {
    await openOptions(page);
    await addExtra(page, `Draps lit ${TAG}`, "8", "per_bed");
    await expect(row(page, `Draps lit ${TAG}`)).toContainText("8 € par lit");
    const fees = page.locator("section").filter({ has: page.getByRole("heading", { name: "Frais", exact: true }) });
    await fees.getByRole("button", { name: "Ajouter", exact: true }).click();
    await expect(page.getByTestId("fee-form").locator('[name="unit"] option[value="per_bed"]')).toHaveCount(0);
  });

  test("frais « par lit » forgé : refusé côté serveur", async ({ page }) => {
    await page.goto("/admin/parametres?tab=etablissement");
    const fees = page.locator("section").filter({ has: page.getByRole("heading", { name: "Frais", exact: true }) });
    await fees.getByRole("button", { name: "Ajouter", exact: true }).click();
    const form = page.getByTestId("fee-form");
    await form.locator('[name="label"]').fill(`Frais lit ${TAG}`);
    await form.locator('[name="price"]').fill("5");
    await form.locator('[name="unit"]').evaluate((s: HTMLSelectElement) => {
      const o = document.createElement("option");
      o.value = "per_bed";
      s.appendChild(o);
      s.value = "per_bed";
    });
    await form.getByRole("button", { name: "Ajouter le frais" }).click();
    await expect(page.getByText("Choisissez une unité").first()).toBeVisible();
    expect((await pool.query("SELECT 1 FROM fees WHERE label = $1", [`Frais lit ${TAG}`])).rowCount).toBe(0);
  });

  test("saisie manuelle : 1 lit sur 3 → quantité 1, devis et total justes", async ({ page }) => {
    const sourceId = await insertExtra({ label: "Linge de lit", price: "8", unit: "per_bed" });
    await fillManual(page, { name: "Par lit", checkIn: day(784), checkOut: day(786) });
    await page.getByLabel(`Linge de lit ${TAG}`).check();
    const qty = page.locator(`[data-testid="extraQty-${sourceId}"]`);
    // Par défaut tous les lits : 2 × 100 € + 3 × 8 € = 224 €
    await expect(qty).toHaveValue("3");
    await expect(quote(page)).toContainText(/224\s€/);
    await qty.selectOption("1");
    await expect(quote(page)).toContainText(/208\s€/);
    await page.click('[type="submit"]');
    await expect(page).toHaveURL(SAVED_BOOKING_URL);
    const id = page.url().match(/reservations\/([0-9a-f-]{36})/)![1];
    expect(await totalOf(id)).toBe("208.00");
    expect(await lines(id)).toEqual([
      { source_id: sourceId, label: `Linge de lit ${TAG}`, unit_price: "8.00", quantity: 1, total: "8.00" },
    ]);

    // Modification : la quantité enregistrée est reprise, puis changée.
    await page.goto(`/admin/reservations/${id}/modifier`);
    const lineId = (await pool.query("SELECT id FROM booking_lines WHERE booking_id = $1", [id])).rows[0].id;
    await expect(page.locator(`[data-testid="extraQty-${lineId}"]`)).toHaveValue("1");
    await page.locator(`[data-testid="extraQty-${lineId}"]`).selectOption("2");
    await saveEdit(page, id);
    expect(await totalOf(id)).toBe("216.00");
    expect((await lines(id))[0].quantity).toBe(2);
  });

  test("quantité forgée (99, 0, abc) : ramenée entre 1 et le nombre de lits", async ({ page }) => {
    const sourceId = await insertExtra({ label: "Draps forgés", price: "8", unit: "per_bed" });
    for (const [forged, expected] of [["99", 3], ["0", 1], ["abc", 3]] as const) {
      await fillManual(page, { name: `Forgé ${forged}`, checkIn: day(787), checkOut: day(788) });
      await page.getByLabel(`Draps forgés ${TAG}`).check();
      await page.locator(`[data-testid="extraQty-${sourceId}"]`).evaluate((s: HTMLSelectElement, [v, id]) => {
        const o = document.createElement("option");
        o.value = v;
        s.appendChild(o);
        s.value = v;
        s.name = `extraQty_${id}`;
      }, [forged, sourceId] as const);
      await page.click('[type="submit"]');
      await expect(page).toHaveURL(SAVED_BOOKING_URL);
      const id = page.url().match(/reservations\/([0-9a-f-]{36})/)![1];
      expect((await lines(id))[0].quantity).toBe(expected);
      await pool.query("DELETE FROM bookings WHERE id = $1", [id]);
    }
  });
});

// ─── Nombre au choix (ADR-0010, amendement 2) ──────────────────────────────────

test.describe("Admin — Option à nombre au choix (paniers…)", () => {
  const chosen = async (bookingId: string) =>
    (await pool.query("SELECT chosen, quantity, total FROM booking_lines WHERE booking_id = $1", [bookingId])).rows[0];

  test("catalogue : maximum enregistré et affiché ; 1 = pas de choix ; « par lit » sans champ ; 0 et 100 refusés", async ({ page }) => {
    const label = `Panier catalogue ${TAG}`;
    await openOptions(page);
    await section(page).getByRole("button", { name: "Ajouter", exact: true }).click();
    const form = page.getByTestId("extra-form");
    await expect(form.getByLabel("Quantité au choix, jusqu'à")).toHaveValue("1");
    for (const [unit, hint] of [
      ["per_bed", "Le client choisit pour combien de lits, jusqu'à ceux de la chambre"],
      ["per_night", "Le client choisit pour combien de nuits, jusqu'à celles du séjour"],
      ["per_guest", "Le client choisit pour combien de personnes, jusqu'aux voyageurs du séjour"],
    ]) {
      await form.locator('[name="unit"]').selectOption(unit);
      await expect(form.getByLabel("Quantité au choix, jusqu'à")).toHaveCount(0);
      await expect(form.getByTestId("extra-choice-hint")).toContainText(hint);
    }
    await form.locator('[name="unit"]').selectOption("per_stay");
    await form.locator('[name="label"]').fill(label);
    await form.locator('[name="price"]').fill("14,90");
    await form.locator("[name='maxQuantity']").evaluate((el) => ((el as HTMLInputElement).form!.noValidate = true));
    for (const [v, msg] of [["0", "Quantité maximum : au moins 1"], ["100", "Quantité maximum : 99 au plus"]]) {
      await form.getByLabel("Quantité au choix, jusqu'à").fill(v);
      await form.getByRole("button", { name: "Ajouter l'option" }).click();
      await expect(page.getByText(msg).first()).toBeVisible();
    }
    expect((await pool.query("SELECT 1 FROM extras WHERE label = $1", [label])).rowCount).toBe(0);

    await form.getByLabel("Quantité au choix, jusqu'à").fill("4");
    await form.getByRole("button", { name: "Ajouter l'option" }).click();
    await expect(row(page, label)).toContainText("14,90 € par séjour · jusqu'à 4 au choix");
    expect((await pool.query("SELECT max_quantity FROM extras WHERE label = $1", [label])).rows[0].max_quantity).toBe(4);

    await row(page, label).getByRole("button", { name: "Modifier" }).click();
    await expect(page.getByTestId("extra-form").getByLabel("Quantité au choix, jusqu'à")).toHaveValue("4");
    await page.getByTestId("extra-form").getByLabel("Quantité au choix, jusqu'à").fill("1");
    await page.getByRole("button", { name: "Enregistrer l'option" }).click();
    await expect(row(page, label)).not.toContainText("au choix");
    expect((await pool.query("SELECT max_quantity FROM extras WHERE label = $1", [label])).rows[0].max_quantity).toBeNull();
  });

  test("saisie manuelle : 2 paniers sur 3 → ligne × 2 ; nombre forgé (50) ramené à 3 ; option sans maximum : pas de choix", async ({ page }) => {
    const panier = await insertExtra({ label: "Panier choix", price: "15", unit: "per_stay", maxQuantity: 3 });
    const simple = await insertExtra({ label: "Ménage simple", price: "20", unit: "per_stay" });
    await fillManual(page, { name: "Paniers", checkIn: day(789), checkOut: day(791) });
    await page.getByLabel(`Panier choix ${TAG}`).check();
    await page.getByLabel(`Ménage simple ${TAG}`).check();
    await expect(page.locator(`[data-testid="extraQty-${simple}"]`)).toHaveCount(0);
    const qty = page.locator(`[data-testid="extraQty-${panier}"]`);
    await expect(qty).toHaveValue("1");
    await expect(qty.locator("option")).toHaveCount(3);
    // 2 × 100 € + 2 × 15 € + 20 € = 250 €
    await qty.selectOption("2");
    await expect(quote(page)).toContainText(/250\s€/);
    await page.click('[type="submit"]');
    await expect(page).toHaveURL(SAVED_BOOKING_URL);
    const id = page.url().match(/reservations\/([0-9a-f-]{36})/)![1];
    expect(await totalOf(id)).toBe("250.00");
    const l = (await pool.query("SELECT chosen, quantity, total FROM booking_lines WHERE booking_id = $1 AND source_id = $2", [id, panier])).rows[0];
    expect(l).toEqual({ chosen: 2, quantity: 2, total: "30.00" });

    await fillManual(page, { name: "Paniers forgés", checkIn: day(792), checkOut: day(793) });
    await page.getByLabel(`Panier choix ${TAG}`).check();
    await qty.evaluate((s: HTMLSelectElement, id) => {
      s.appendChild(new Option("50", "50"));
      s.value = "50";
      s.name = `extraQty_${id}`;
    }, panier);
    await page.click('[type="submit"]');
    await expect(page).toHaveURL(SAVED_BOOKING_URL);
    const forged = page.url().match(/reservations\/([0-9a-f-]{36})/)![1];
    expect(await chosen(forged)).toEqual({ chosen: 3, quantity: 3, total: "45.00" });
  });

  test("par nuit : 2 nuits sur 3 choisies ; séjour allongé → le choix reste 2, une option « tout le séjour » suit", async ({ page }) => {
    const velo = await insertExtra({ label: "Vélo", price: "10", unit: "per_night" });
    const dej = await insertExtra({ label: "Dej nuit", price: "5", unit: "per_night" });
    await fillManual(page, { name: "Vélos", checkIn: day(794), checkOut: day(797) });
    await page.getByLabel(`Vélo ${TAG}`).check();
    await page.getByLabel(`Dej nuit ${TAG}`).check();
    const qty = page.locator(`[data-testid="extraQty-${velo}"]`);
    // 3 nuits proposées, tout le séjour par défaut.
    await expect(qty.locator("option")).toHaveText(["1 nuit", "2 nuits", "3 nuits"]);
    await expect(qty).toHaveValue("3");
    await qty.selectOption("2");
    // 3 × 100 € + 2 × 10 € + 3 × 5 € = 335 €
    await expect(quote(page)).toContainText(/335\s€/);
    await page.click('[type="submit"]');
    await expect(page).toHaveURL(SAVED_BOOKING_URL);
    const id = page.url().match(/reservations\/([0-9a-f-]{36})/)![1];
    const byLabel = async () =>
      Object.fromEntries(
        (await pool.query("SELECT source_id, chosen, quantity FROM booking_lines WHERE booking_id = $1", [id])).rows.map((r) => [
          r.source_id,
          { chosen: r.chosen, quantity: r.quantity },
        ]),
      );
    expect(await byLabel()).toEqual({ [velo]: { chosen: 2, quantity: 2 }, [dej]: { chosen: null, quantity: 3 } });

    // 3 → 4 nuits, enregistré tout de suite (avant le recalcul du devis) : rien n'est faussé.
    await page.goto(`/admin/reservations/${id}/modifier`);
    await page.locator('[name="checkOut"]').fill(day(798));
    await saveEdit(page, id);
    const after = await byLabel();
    expect(after[velo]).toEqual({ chosen: 2, quantity: 2 });
    expect(after[dej]).toEqual({ chosen: null, quantity: 4 });
  });
});
