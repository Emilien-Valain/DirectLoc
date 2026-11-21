import { test, expect, type Page } from "@playwright/test";
import fs from "fs";
import path from "path";
import { Pool } from "pg";
import { deleteOrphanDossiers } from "../helpers/dossier";
import { confirmDialog } from "../helpers/confirm";

/**
 * Spécification : Tests de non-régression > Admin > Dossiers (plusieurs chambres)
 * Issue `.scratch/dossiers/issues/05-admin-dossier.md`, ADR-0012.
 *
 * Fiche Dossier, saisie manuelle de plusieurs chambres (avec « Forcer »), annulation
 * d'une chambre seule / de tout le Dossier, reste à payer commun, marque « groupe »
 * (liste, calendrier), PDF du Dossier, 404 / isolation / XSS.
 *
 * Données : trois chambres dédiées (apiRoom est partagée par d'autres specs en parallèle),
 * dates en 2035, tout est supprimé en afterEach/afterAll (réservations, paiements, Dossiers, chambres).
 */

const ctx = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "e2e", ".auth", "test-context.json"), "utf-8"),
) as { tenantId: string; apiRoomId: string; rivalTenantId: string; rivalRoomId: string };

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const STAMP = Date.now().toString(36);
const EMAIL = `dossier-admin-${STAMP}@example.com`;
const UUID_RE = "[0-9a-f-]{36}";

let roomA: string;
let roomB: string;
let roomC: string;
const ROOM_NAMES = { a: `Dossier Admin A ${STAMP}`, b: `Dossier Admin B ${STAMP}`, c: `Dossier Admin C ${STAMP}` };

async function insertRoom(letter: "a" | "b" | "c", capacity: number) {
  const name = ROOM_NAMES[letter];
  const { rows } = await pool.query(
    `INSERT INTO rooms (tenant_id, property_id, name, slug, price_per_night, capacity)
     SELECT tenant_id, property_id, $2, $3, '100.00', $4 FROM rooms WHERE id = $1 RETURNING id`,
    [ctx.apiRoomId, name, `dossier-admin-${letter}-${STAMP}`, capacity],
  );
  return rows[0].id as string;
}

type RoomRow = { roomId: string; total: string; status?: string; guests?: number };

/** Dossier inséré en SQL (tenant donné) ; ids du Dossier et de ses réservations, dans l'ordre. */
async function insertDossier(
  rooms: RoomRow[],
  opts: {
    checkIn: string;
    checkOut: string;
    name?: string;
    tenantId?: string;
    source?: "direct" | "manual";
    payment?: { amount: string; status: string };
  },
) {
  const tenantId = opts.tenantId ?? ctx.tenantId;
  const name = opts.name ?? `Famille Dossier ${STAMP}`;
  const { rows } = await pool.query(
    `INSERT INTO dossiers (tenant_id, check_in, check_out, guest_name, guest_email, guest_phone)
     VALUES ($1, $2, $3, $4, $5, '06 11 22 33 44') RETURNING id`,
    [tenantId, opts.checkIn, opts.checkOut, name, EMAIL],
  );
  const dossierId = rows[0].id as string;
  const bookingIds: string[] = [];
  for (const r of rooms) {
    const res = await pool.query(
      `INSERT INTO bookings (tenant_id, dossier_id, room_id, check_in, check_out, total_price, status, guest_name, guest_email, guest_count, source, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now() + ($12 || ' milliseconds')::interval) RETURNING id`,
      [tenantId, dossierId, r.roomId, opts.checkIn, opts.checkOut, r.total, r.status ?? "confirmed", name, EMAIL, r.guests ?? 2, opts.source ?? "direct", String(bookingIds.length)],
    );
    bookingIds.push(res.rows[0].id);
  }
  if (opts.payment) {
    await pool.query(
      `INSERT INTO payments (tenant_id, dossier_id, stripe_session_id, stripe_payment_id, amount, currency, status)
       VALUES ($1, $2, $3, $4, $5, 'eur', $6)`,
      [tenantId, dossierId, `cs_test_dossier_admin_${STAMP}_${Math.random()}`, `pi_test_dossier_admin_${STAMP}`, opts.payment.amount, opts.payment.status],
    );
  }
  return { dossierId, bookingIds };
}

/** Tout ce que ce spec a pu créer : réservations de ses chambres ou à son email (rival compris). */
async function cleanup() {
  const rooms = [roomA, roomB, roomC].filter(Boolean);
  const { rows } = await pool.query(
    `SELECT DISTINCT dossier_id FROM bookings WHERE room_id = ANY($1::uuid[]) OR guest_email = $2`,
    [rooms, EMAIL],
  );
  const ids = rows.map((r) => r.dossier_id as string);
  await pool.query("DELETE FROM payments WHERE dossier_id = ANY($1::uuid[])", [ids]);
  await pool.query("DELETE FROM bookings WHERE dossier_id = ANY($1::uuid[])", [ids]);
  await pool.query("DELETE FROM dossiers WHERE id = ANY($1::uuid[]) OR guest_email = $2", [ids, EMAIL]);
  await deleteOrphanDossiers(pool);
}

const statusesOf = async (dossierId: string) =>
  Object.fromEntries(
    (await pool.query("SELECT room_id, status FROM bookings WHERE dossier_id = $1", [dossierId])).rows.map((r) => [
      r.room_id,
      r.status,
    ]),
  );

/** Nuits bloquées d'une chambre sur la fenêtre (API publique, Holds). */
async function blocked(page: Page, roomId: string, from: string, to: string) {
  const res = await page.request.get(`/api/availability?roomId=${roomId}&from=${from}&to=${to}`);
  expect(res.status()).toBe(200);
  return ((await res.json()) as { blockedDates: string[] }).blockedDates;
}

/** Remplit le formulaire « Nouvelle réservation » avec une 2e chambre. */
async function fillTwoRoomForm(page: Page, opts: { checkIn: string; checkOut: string; second: string; secondGuests: string; name: string }) {
  await page.goto("/admin/reservations/new");
  await page.locator('select[name="roomId"]').selectOption(roomA);
  await page.locator('[name="checkIn"]').fill(opts.checkIn);
  await page.locator('[name="checkOut"]').fill(opts.checkOut);
  await page.locator('[name="guestFirstName"]').fill("Famille");
  await page.locator('[name="guestLastName"]').fill(opts.name);
  await page.fill('[name="guestEmail"]', EMAIL);
  await page.fill('[name="guestCount"]', "2");
  await page.getByRole("button", { name: "+ Ajouter une chambre" }).click();
  const more = page.locator("[data-more-room='0']");
  await more.locator("select").selectOption(opts.second);
  await more.locator('input[type="number"]').first().fill(opts.secondGuests);
}

test.describe("Admin — Dossiers de plusieurs chambres", () => {
  test.beforeAll(async () => {
    roomA = await insertRoom("a", 4);
    roomB = await insertRoom("b", 3);
    roomC = await insertRoom("c", 2);
  });
  test.afterEach(cleanup);
  test.afterAll(async () => {
    await cleanup();
    await pool.query("DELETE FROM rooms WHERE id = ANY($1::uuid[])", [[roomA, roomB, roomC]]);
    await pool.end();
  });

  // ─── Happy path : saisie, annulation d'une chambre, annulation du Dossier ──────

  test("saisie manuelle de 2 chambres → un Dossier ; annuler une chambre libère seulement elle ; annuler le Dossier", async ({ page }) => {
    test.setTimeout(60000);
    const [checkIn, checkOut] = ["2035-03-05", "2035-03-08"];
    await fillTwoRoomForm(page, { checkIn, checkOut, second: roomB, secondGuests: "3", name: `Durand ${STAMP}` });
    // Devis par chambre et total, avant d'enregistrer.
    await expect(page.locator("[data-dossier-quote]")).toContainText(ROOM_NAMES.a);
    await expect(page.locator("[data-dossier-quote]")).toContainText(ROOM_NAMES.b);
    await expect(page.getByText("Total 2 chambres")).toBeVisible();
    // Le prix convenu ne vaut que pour une chambre seule.
    await expect(page.locator('[name="agreedPrice"]')).toBeDisabled();

    await page.getByRole("button", { name: "Enregistrer", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/admin/dossiers/${UUID_RE}\\?enregistre=1$`));
    const dossierId = page.url().match(new RegExp(`/admin/dossiers/(${UUID_RE})`))![1];
    await expect(page.getByText("Dossier enregistré : 2 chambres")).toBeVisible();
    await expect(page.getByRole("heading", { name: `Famille Durand ${STAMP}` })).toBeVisible();

    // En base : deux réservations confirmées, mêmes dates, même voyageur, saisie manuelle.
    const { rows } = await pool.query(
      `SELECT b.id, b.room_id, b.status, b.source, b.guest_count, b.check_in = d.check_in AND b.check_out = d.check_out AS same_dates, b.guest_name = d.guest_name AS same_guest
       FROM bookings b JOIN dossiers d ON d.id = b.dossier_id WHERE b.dossier_id = $1`,
      [dossierId],
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === "confirmed" && r.source === "manual" && r.same_dates && r.same_guest)).toBe(true);
    expect(Object.fromEntries(rows.map((r) => [r.room_id, r.guest_count]))).toEqual({ [roomA]: 2, [roomB]: 3 });
    const bookingB = rows.find((r) => r.room_id === roomB)!.id as string;
    expect(await blocked(page, roomA, checkIn, checkOut)).toContain(checkIn);
    expect(await blocked(page, roomB, checkIn, checkOut)).toContain(checkIn);

    // Chaque chambre mène à sa réservation, qui renvoie au Dossier.
    await page.locator(`[data-dossier-room="${bookingB}"]`).getByRole("link", { name: "Voir la réservation" }).click();
    await expect(page).toHaveURL(new RegExp(`/admin/reservations/${bookingB}$`));
    await expect(page.locator("[data-dossier-link]")).toContainText("Dossier de 2 chambres");
    await page.locator("[data-dossier-link]").click();
    await expect(page).toHaveURL(new RegExp(`/admin/dossiers/${dossierId}$`));

    // Annuler la chambre B seule : A reste confirmée, B est libre.
    await page.locator(`[data-dossier-room="${bookingB}"]`).getByRole("button", { name: "Annuler cette chambre" }).click();
    await expect(page.locator("dialog[open]")).toContainText("l'autre chambre reste réservée");
    await confirmDialog(page);
    await expect(page).toHaveURL(/chambre-annulee=(1|sans-email)$/);
    expect(await statusesOf(dossierId)).toEqual({ [roomA]: "confirmed", [roomB]: "cancelled" });
    expect(await blocked(page, roomB, checkIn, checkOut)).toEqual([]);
    expect(await blocked(page, roomA, checkIn, checkOut)).toContain(checkIn);
    // Une seule chambre active : plus d'annulation par chambre, seulement le Dossier entier.
    await expect(page.getByRole("button", { name: "Annuler cette chambre" })).toHaveCount(0);

    // Annuler tout le Dossier : A aussi est libérée ; pas de remboursement (rien payé en ligne).
    await page.getByRole("button", { name: "Annuler tout le Dossier" }).click();
    await expect(page.locator("dialog[open] [data-refund-note]")).toHaveText("Aucun paiement en ligne à rembourser.");
    await confirmDialog(page);
    await expect(page).toHaveURL(/annule=(1|sans-email)$/);
    expect(await statusesOf(dossierId)).toEqual({ [roomA]: "cancelled", [roomB]: "cancelled" });
    expect(await blocked(page, roomA, checkIn, checkOut)).toEqual([]);
    await expect(page.getByRole("button", { name: "Annuler tout le Dossier" })).toHaveCount(0);
  });

  test("chambre déjà occupée : rien n'est créé, le conflit nomme la chambre ; « Forcer » crée tout le Dossier", async ({ page }) => {
    const [checkIn, checkOut] = ["2035-04-02", "2035-04-04"];
    // Un séjour occupe déjà la chambre B.
    await insertDossier([{ roomId: roomB, total: "200.00" }], { checkIn, checkOut, name: `Occupant ${STAMP}`, source: "manual" });

    await fillTwoRoomForm(page, { checkIn, checkOut, second: roomB, secondGuests: "1", name: `Force ${STAMP}` });
    await page.getByRole("button", { name: "Enregistrer", exact: true }).click();
    const panel = page.locator("[data-force-panel]");
    await expect(panel).toContainText(`${ROOM_NAMES.b} : Ces dates chevauchent le séjour de Occupant ${STAMP}`);
    // Tout ou rien : la chambre A, libre, n'a pas été réservée seule.
    expect((await pool.query("SELECT 1 FROM bookings WHERE guest_name = $1", [`Famille Force ${STAMP}`])).rowCount).toBe(0);
    // Les chambres saisies survivent à l'erreur.
    await expect(page.locator("[data-more-room='0'] select")).toHaveValue(roomB);

    await panel.locator('input[name="force"]').check();
    await page.getByRole("button", { name: "Enregistrer", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/admin/dossiers/${UUID_RE}\\?enregistre=1$`));
    expect(
      (await pool.query("SELECT 1 FROM bookings WHERE guest_name = $1 AND status = 'confirmed'", [`Famille Force ${STAMP}`])).rowCount,
    ).toBe(2);
  });

  test("capacité dépassée sur la 2e chambre : erreur nommant la chambre, rien n'est créé", async ({ page }) => {
    await fillTwoRoomForm(page, { checkIn: "2035-04-10", checkOut: "2035-04-12", second: roomC, secondGuests: "5", name: `Trop ${STAMP}` });
    await page.getByRole("button", { name: "Enregistrer", exact: true }).click();
    await expect(page.getByText(`${ROOM_NAMES.c} : Cette chambre accueille 2 personnes maximum`)).toBeVisible();
    expect((await pool.query("SELECT 1 FROM bookings WHERE guest_email = $1", [EMAIL])).rowCount).toBe(0);
  });

  test("même chambre choisie deux fois : impossible depuis le formulaire, refusée par le serveur", async ({ page }) => {
    await page.goto("/admin/reservations/new");
    await page.locator('select[name="roomId"]').selectOption(roomA);
    await page.getByRole("button", { name: "+ Ajouter une chambre" }).click();
    // La chambre déjà choisie n'est pas proposée pour la 2e.
    await expect(page.locator(`[data-more-room='0'] select option[value="${roomA}"]`)).toHaveCount(0);
    // Requête forgée : le serveur refuse quand même.
    await page.locator('[name="checkIn"]').fill("2035-04-20");
    await page.locator('[name="checkOut"]').fill("2035-04-21");
    await page.locator('[name="guestLastName"]').fill(`Doublon ${STAMP}`);
    await page.fill('[name="guestEmail"]', EMAIL);
    await page.locator("[data-more-room='0'] select").selectOption(roomB);
    await page.locator('input[name="moreRooms"]').evaluate(
      (el, id) => ((el as HTMLInputElement).value = JSON.stringify([{ roomId: id, guestCount: 1, childCount: 0 }])),
      roomA,
    );
    await page.getByRole("button", { name: "Enregistrer", exact: true }).click();
    await expect(page.getByText("La même chambre est choisie deux fois.")).toBeVisible();
    expect((await pool.query("SELECT 1 FROM bookings WHERE guest_email = $1", [EMAIL])).rowCount).toBe(0);
  });

  // ─── Paiement commun : reste à payer, trop-perçu ───────────────────────────────

  test("reste à payer sur 2 chambres : calculé sur le Dossier, pas chambre par chambre ; trop-perçu après annulation", async ({ page }) => {
    // Payé 540 € en ligne pour 270 + 270 ; une option de 30 € ajoutée depuis sur la 2e chambre.
    const { dossierId, bookingIds } = await insertDossier(
      [
        { roomId: roomA, total: "270.00" },
        { roomId: roomB, total: "300.00" },
      ],
      { checkIn: "2035-05-03", checkOut: "2035-05-06", payment: { amount: "540.00", status: "paid" } },
    );
    await page.goto(`/admin/dossiers/${dossierId}`);
    await expect(page.locator("[data-balance-due]")).toHaveText("30 €");
    await expect(page.getByText("Payé en ligne", { exact: true }).first()).toBeVisible();
    await expect(page.locator("[data-refund-due]")).toHaveCount(0);

    // Fiche d'une chambre : plus le total du Dossier présenté comme payé pour elle, ni de reste faux.
    await page.goto(`/admin/reservations/${bookingIds[0]}`);
    await expect(page.locator("[data-balance-due]")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Payé en ligne avec le Dossier" })).toBeVisible();
    await expect(page.getByText("540 €")).toHaveCount(0);

    // Annuler la 2e chambre : le séjour coûte 270 €, 270 € sont à rembourser à la main.
    await page.goto(`/admin/dossiers/${dossierId}`);
    await page.locator(`[data-dossier-room="${bookingIds[1]}"]`).getByRole("button", { name: "Annuler cette chambre" }).click();
    await expect(page.locator("dialog[open]")).toContainText("l'annulation ne rembourse rien");
    await confirmDialog(page);
    await expect(page).toHaveURL(/chambre-annulee=/);
    await expect(page.locator("[data-refund-due]")).toContainText("remboursez 270 € depuis votre tableau de bord Stripe");
    await expect(page.locator("[data-balance-due]")).toHaveCount(0);
    // La fiche de la chambre annulée renvoie au Dossier pour le remboursement (pas le montant total).
    await page.goto(`/admin/reservations/${bookingIds[1]}`);
    await expect(page.getByText("le montant à rembourser depuis Stripe est indiqué sur la fiche du Dossier")).toBeVisible();
  });

  test("Dossier saisi à la main : « Marquer réglé » règle toutes les chambres, « Pas encore réglé » annule", async ({ page }) => {
    const { dossierId } = await insertDossier(
      [
        { roomId: roomA, total: "200.00" },
        { roomId: roomB, total: "150.00" },
      ],
      { checkIn: "2035-05-20", checkOut: "2035-05-22", source: "manual" },
    );
    await page.goto(`/admin/dossiers/${dossierId}`);
    await expect(page.getByText("Total du séjour")).toBeVisible();
    await expect(page.getByText("350 €")).toBeVisible();
    await page.getByRole("button", { name: "Marquer réglé" }).click();
    await expect(page.getByText("Réglé", { exact: true })).toBeVisible();
    const paid = await pool.query("SELECT count(*)::int AS n FROM bookings WHERE dossier_id = $1 AND paid_at IS NOT NULL", [dossierId]);
    expect(paid.rows[0].n).toBe(2);
    await page.getByRole("button", { name: "Pas encore réglé" }).click();
    await expect(page.getByRole("button", { name: "Marquer réglé" })).toBeVisible();
  });

  // ─── Modification d'une chambre d'un Dossier ───────────────────────────────────

  test("modifier une chambre : le voyageur suit sur tout le Dossier ; des dates différentes sont refusées", async ({ page }) => {
    const { dossierId, bookingIds } = await insertDossier(
      [
        { roomId: roomA, total: "200.00" },
        { roomId: roomB, total: "200.00" },
      ],
      { checkIn: "2035-06-03", checkOut: "2035-06-05", source: "manual" },
    );
    await page.goto(`/admin/reservations/${bookingIds[0]}/modifier`);
    await expect(page.locator("[data-dossier-dates]")).toContainText("Dates communes aux 2 chambres");

    // Dates différentes pour une seule chambre : refusé, rien ne bouge.
    await page.locator('[name="checkOut"]').evaluate((el) => el.removeAttribute("readonly"));
    await page.locator('[name="checkOut"]').fill("2035-06-06");
    await page.getByRole("button", { name: "Enregistrer les modifications" }).click();
    await expect(page.getByText("ont les mêmes dates")).toBeVisible();
    const dates = await pool.query("SELECT DISTINCT check_out::date::text AS d FROM bookings WHERE dossier_id = $1", [dossierId]);
    expect(dates.rows.map((r) => r.d)).toEqual(["2035-06-05"]);

    // Voyageur corrigé sur une chambre : le Dossier et l'autre chambre suivent.
    await page.goto(`/admin/reservations/${bookingIds[0]}/modifier`);
    await page.locator('[name="guestLastName"]').fill(`Renommé ${STAMP}`);
    await page.locator('[name="notifyGuest"]').uncheck();
    await page.getByRole("button", { name: "Enregistrer les modifications" }).click();
    await expect(page).toHaveURL(/modifiee=silence$/);
    const names = await pool.query(
      "SELECT DISTINCT guest_name FROM bookings WHERE dossier_id = $1 UNION ALL SELECT guest_name FROM dossiers WHERE id = $1",
      [dossierId],
    );
    expect(new Set(names.rows.map((r) => r.guest_name))).toEqual(new Set([`Famille Renommé ${STAMP}`]));
  });

  // ─── Marque « groupe » : liste et calendrier ───────────────────────────────────

  test("liste : lien vers le Dossier sur les réservations d'un Dossier de 2 chambres, pas sur une chambre seule", async ({ page }) => {
    const name = `Groupe Liste ${STAMP}`;
    const { dossierId } = await insertDossier(
      [
        { roomId: roomA, total: "100.00" },
        { roomId: roomB, total: "100.00" },
      ],
      { checkIn: "2035-07-01", checkOut: "2035-07-02", name },
    );
    await insertDossier([{ roomId: roomC, total: "100.00" }], { checkIn: "2035-07-01", checkOut: "2035-07-02", name: `${name} Solo` });
    await page.goto(`/admin/reservations?q=${encodeURIComponent(name)}`);
    const links = page.locator("[data-dossier-link]");
    await expect(links).toHaveCount(2);
    await expect(links.first()).toHaveAttribute("href", `/admin/dossiers/${dossierId}`);
    await links.first().click();
    await expect(page).toHaveURL(new RegExp(`/admin/dossiers/${dossierId}$`));
  });

  test("calendrier : marque « groupe » sur les 2 chambres du Dossier, pas sur une réservation seule", async ({ page }) => {
    const name = `Groupe Cal ${STAMP}`;
    const { dossierId } = await insertDossier(
      [
        { roomId: roomA, total: "100.00" },
        { roomId: roomB, total: "100.00" },
      ],
      { checkIn: "2035-08-10", checkOut: "2035-08-12", name },
    );
    await insertDossier([{ roomId: roomC, total: "100.00" }], { checkIn: "2035-08-10", checkOut: "2035-08-12", name: `Seul ${STAMP}` });
    await page.goto("/admin/calendrier?year=2035&month=7");
    const grouped = page.locator(`button[data-group="2"][aria-label^="${name}"]`);
    await expect(grouped).toHaveCount(2);
    await expect(grouped.first()).toHaveAttribute("aria-label", /Groupe de 2 chambres/);
    await expect(page.locator(`button[aria-label^="Seul ${STAMP}"]`)).not.toHaveAttribute("data-group", /.*/);
    // Le détail ouvre le Dossier.
    await grouped.first().click();
    await page.getByRole("link", { name: "Dossier · 2 chambres" }).click();
    await expect(page).toHaveURL(new RegExp(`/admin/dossiers/${dossierId}$`));
  });

  // ─── PDF ───────────────────────────────────────────────────────────────────────

  test("PDF du Dossier entier : 200, un PDF ; inconnu, mal formé ou d'un autre tenant → 404", async ({ page }) => {
    const { dossierId } = await insertDossier(
      [
        { roomId: roomA, total: "100.00" },
        { roomId: roomB, total: "120.00", status: "cancelled" },
      ],
      { checkIn: "2035-09-01", checkOut: "2035-09-03", name: `PDF ☕ ${STAMP}` },
    );
    const rival = await insertDossier([{ roomId: ctx.rivalRoomId, total: "100.00" }], {
      checkIn: "2035-09-01",
      checkOut: "2035-09-03",
      tenantId: ctx.rivalTenantId,
    });
    const res = await page.request.get(`/api/admin/dossiers/${dossierId}/pdf`);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("application/pdf");
    expect(res.headers()["content-disposition"]).toContain(`dossier-${dossierId.slice(0, 8)}`);
    expect((await res.body()).subarray(0, 4).toString()).toBe("%PDF");

    // Le bouton de la fiche télécharge ce PDF.
    await page.goto(`/admin/dossiers/${dossierId}`);
    const download = page.waitForEvent("download");
    await page.getByRole("link", { name: "PDF du Dossier" }).click();
    expect((await download).suggestedFilename()).toMatch(/^dossier-.*\.pdf$/);

    for (const id of ["00000000-0000-0000-0000-000000000000", "pas-un-uuid", rival.dossierId]) {
      expect((await page.request.get(`/api/admin/dossiers/${id}/pdf`, { maxRedirects: 0 })).status()).toBe(404);
    }
  });

  // ─── Erreurs, isolation, sécurité ──────────────────────────────────────────────

  test("fiche : UUID inexistant, id mal formé, Dossier d'un autre tenant → 404, jamais 500", async ({ page }) => {
    const rival = await insertDossier([{ roomId: ctx.rivalRoomId, total: "100.00" }], {
      checkIn: "2035-10-01",
      checkOut: "2035-10-02",
      tenantId: ctx.rivalTenantId,
      name: `Rival Secret ${STAMP}`,
    });
    for (const id of ["00000000-0000-0000-0000-000000000000", "pas-un-uuid", "%27%20OR%201%3D1", rival.dossierId]) {
      const res = await page.goto(`/admin/dossiers/${id}`);
      expect(res?.status()).toBe(404);
      await expect(page.getByText(`Rival Secret ${STAMP}`)).toHaveCount(0);
    }
  });

  test("XSS dans le nom du voyageur : affiché échappé sur la fiche, aucun dialog", async ({ page }) => {
    let dialog = false;
    page.on("dialog", async (d) => {
      dialog = true;
      await d.dismiss();
    });
    const xss = `<script>alert(1)</script><img src=x onerror=alert(2)> ${STAMP}`;
    const { dossierId } = await insertDossier(
      [
        { roomId: roomA, total: "100.00" },
        { roomId: roomB, total: "100.00" },
      ],
      { checkIn: "2035-11-02", checkOut: "2035-11-03", name: xss },
    );
    await page.goto(`/admin/dossiers/${dossierId}`);
    await expect(page.getByRole("heading", { name: xss })).toBeVisible();
    expect(await page.locator("[data-dossier] script").count()).toBe(0);
    // Le dialog d'annulation interpole aussi le nom.
    await page.getByRole("button", { name: "Annuler tout le Dossier" }).click();
    await expect(page.locator("dialog[open]")).toContainText("<script>alert(1)</script>");
    await page.getByRole("button", { name: "Garder" }).click();
    expect(dialog).toBe(false);
    expect((await page.request.get(`/api/admin/dossiers/${dossierId}/pdf`)).status()).toBe(200);
  });

  test("sans session : la fiche et le PDF du Dossier redirigent vers /login", async ({ browser }) => {
    const { dossierId } = await insertDossier([{ roomId: roomA, total: "100.00" }], { checkIn: "2035-11-10", checkOut: "2035-11-11" });
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();
    try {
      await page.goto(`/admin/dossiers/${dossierId}`);
      await expect(page).toHaveURL(/\/login/);
      const res = await page.request.get(`/api/admin/dossiers/${dossierId}/pdf`, { maxRedirects: 0 });
      expect([401, 302, 307]).toContain(res.status());
    } finally {
      await context.close();
    }
  });
});
