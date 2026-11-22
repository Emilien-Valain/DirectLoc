import { test, expect, type Page } from "@playwright/test";
import fs from "fs";
import path from "path";
import { Pool } from "pg";
import { deleteOrphanDossiers } from "../helpers/dossier";
import { confirmDialog } from "../helpers/confirm";
import { startFakeStripe, type FakeStripe } from "../helpers/fake-stripe";
import { startSmtpSink } from "../helpers/smtp-sink";
import { mailSubject } from "../helpers/mail-body";

/**
 * Spécification : Tests de non-régression > Admin > Remboursements
 * Issue `.scratch/remboursements-litiges/issues/02-refunds.md` (PRD « Remboursements »).
 *
 * Bouton « Rembourser » de la fiche Dossier (montant libre, raccourcis, motif), case « Rembourser
 * X € » des dialogs d'annulation (chambre, Dossier, fiche réservation), plafond (UI et requête
 * forgée), suggestion selon le niveau d'annulation du Dossier, argent recalculé, hors ligne,
 * Stripe en erreur, email au voyageur. Stripe simulé (`fake-stripe.ts`), SMTP capté.
 * Logique serveur, isolation multi-tenant, démo : `e2e/unit/refund-isolation.spec.ts`.
 *
 * Données : chambres dédiées, dates en 2036 (sauf J-5), tout supprimé en afterEach/afterAll.
 */

const ctx = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "e2e", ".auth", "test-context.json"), "utf-8"),
) as { tenantId: string; apiRoomId: string };

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const STAMP = Date.now().toString(36);
const EMAIL = `refunds-${STAMP}@example.com`;
const NAMES = { a: `Remb A ${STAMP}`, b: `Remb B ${STAMP}` };
let roomA: string;
let roomB: string;
let stripe: FakeStripe;
let sink: Awaited<ReturnType<typeof startSmtpSink>>;

const parisDay = (offset: number) => {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(new Date());
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};

async function insertRoom(name: string, slug: string) {
  const { rows } = await pool.query(
    `INSERT INTO rooms (tenant_id, property_id, name, slug, price_per_night, capacity)
     SELECT tenant_id, property_id, $2, $3, '100.00', 4 FROM rooms WHERE id = $1 RETURNING id`,
    [ctx.apiRoomId, name, slug],
  );
  return rows[0].id as string;
}

/** Dossier payé en ligne (ou réglé hors ligne), inséré en SQL ; ids du Dossier et des chambres. */
async function insertDossier(
  rooms: { roomId: string; total: string; status?: string }[],
  opts: { paid?: string; offline?: boolean; checkIn?: string; checkOut?: string; level?: string | null } = {},
) {
  const checkIn = opts.checkIn ?? "2036-06-10";
  const checkOut = opts.checkOut ?? "2036-06-13";
  const name = `Voyageur Remb ${STAMP}`;
  const { rows } = await pool.query(
    `INSERT INTO dossiers (tenant_id, check_in, check_out, guest_name, guest_email, cancellation_level)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [ctx.tenantId, checkIn, checkOut, name, EMAIL, opts.level ?? null],
  );
  const dossierId = rows[0].id as string;
  const bookingIds: string[] = [];
  for (const r of rooms) {
    const res = await pool.query(
      `INSERT INTO bookings (tenant_id, dossier_id, room_id, check_in, check_out, total_price, status, guest_name, guest_email, guest_count, source, paid_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 2, $10, $11, now() + ($12 || ' milliseconds')::interval) RETURNING id`,
      [ctx.tenantId, dossierId, r.roomId, checkIn, checkOut, r.total, r.status ?? "confirmed", name, EMAIL, opts.offline ? "manual" : "direct", opts.offline ? new Date() : null, String(bookingIds.length)],
    );
    bookingIds.push(res.rows[0].id);
  }
  if (opts.paid) {
    await pool.query(
      `INSERT INTO payments (tenant_id, dossier_id, stripe_session_id, stripe_payment_id, amount, currency, status)
       VALUES ($1, $2, $3, $4, $5, 'eur', 'paid')`,
      [ctx.tenantId, dossierId, `cs_test_refunds_${STAMP}_${Math.random()}`, `pi_test_refunds_${dossierId}`, opts.paid],
    );
  }
  return { dossierId, bookingIds };
}

const refundsOf = async (dossierId: string) =>
  (await pool.query("SELECT amount, booking_id, reason, status FROM refunds WHERE dossier_id = $1 ORDER BY created_at", [dossierId])).rows;
const stripeCalls = (dossierId: string) => stripe.refunds.filter((x) => x.params["metadata[dossierId]"] === dossierId);
const refundMails = () => sink.mails.filter((m) => m.to.includes(EMAIL) && mailSubject(m).startsWith("Remboursement de"));

const refundDialog = (page: Page) => page.locator("dialog[data-refund-dialog][open]");
async function openRefund(page: Page) {
  await page.locator("[data-refund-open]").click();
  await expect(refundDialog(page)).toBeVisible();
  return refundDialog(page);
}

async function cleanup() {
  const { rows } = await pool.query(
    "SELECT DISTINCT dossier_id FROM bookings WHERE room_id = ANY($1::uuid[]) OR guest_email = $2",
    [[roomA, roomB].filter(Boolean), EMAIL],
  );
  const ids = rows.map((r) => r.dossier_id as string);
  await pool.query("DELETE FROM refunds WHERE dossier_id = ANY($1::uuid[])", [ids]);
  await pool.query("DELETE FROM payments WHERE dossier_id = ANY($1::uuid[])", [ids]);
  await pool.query("DELETE FROM bookings WHERE dossier_id = ANY($1::uuid[])", [ids]);
  await pool.query("DELETE FROM dossiers WHERE id = ANY($1::uuid[]) OR guest_email = $2", [ids, EMAIL]);
  await deleteOrphanDossiers(pool);
}

test.describe("Admin — Remboursements", () => {
  test.beforeAll(async () => {
    roomA = await insertRoom(NAMES.a, `remb-a-${STAMP}`);
    roomB = await insertRoom(NAMES.b, `remb-b-${STAMP}`);
    stripe = await startFakeStripe();
    sink = await startSmtpSink();
  });
  test.beforeEach(() => {
    sink.mails.length = 0;
    stripe.refundError = null;
    stripe.refundStatus = "succeeded";
  });
  test.afterEach(cleanup);
  test.afterAll(async () => {
    await cleanup();
    await pool.query("DELETE FROM rooms WHERE id = ANY($1::uuid[])", [[roomA, roomB]]);
    // Nettoyage vérifié : plus rien de ce spec en base.
    const left = await pool.query("SELECT count(*)::int AS n FROM dossiers WHERE guest_email = $1", [EMAIL]);
    expect(left.rows[0].n).toBe(0);
    await stripe.close();
    await sink.stop();
    await pool.end();
  });

  test("rembourser tout depuis la fiche : Refund sur le compte de l'hôtel, ligne « Effectué », email au voyageur", async ({ page }) => {
    const { dossierId } = await insertDossier([{ roomId: roomA, total: "240.00" }], { paid: "240.00" });
    await page.goto(`/admin/dossiers/${dossierId}`);
    const dialog = await openRefund(page);
    await expect(dialog.locator("[data-refund-fees]")).toHaveText("Les frais Stripe du paiement ne vous sont pas rendus.");
    await expect(dialog.locator("[data-refund-cap]")).toHaveText(/Au plus 240\s€\./);
    await dialog.locator('[data-refund-shortcut="Tout le restant"]').click();
    await expect(dialog.locator('input[name="amount"]')).toHaveValue("240");
    await dialog.locator("[data-refund-submit]").click();

    await expect(page).toHaveURL(/\?rembourse=1$/);
    await expect(page.locator("[data-refund-banner]")).toHaveText(new RegExp(`Remboursement de 240\\s€ effectué\\. ${EMAIL} a été prévenu`));
    const rows = await refundsOf(dossierId);
    expect(rows).toEqual([{ amount: "240.00", booking_id: null, reason: null, status: "succeeded" }]);
    const [call] = stripeCalls(dossierId);
    expect(call.stripeAccount).toBe("acct_test_e2e_main");
    expect(call.params).toMatchObject({ payment_intent: `pi_test_refunds_${dossierId}`, amount: "24000", "metadata[tenantId]": ctx.tenantId });
    expect(call.idempotencyKey).toMatch(/^refund_/);

    // Une ligne par mouvement ; encaissé net 0 ; plus de bouton.
    await expect(page.locator("[data-money-moves] li")).toHaveCount(2);
    await expect(page.locator("[data-money-moves]")).toContainText("Effectué");
    await expect(page.locator("[data-net-paid]")).toHaveText(/^0\s€$/);
    await expect(page.locator("[data-refund-open]")).toHaveCount(0);
    await expect(page.getByText("Paiement entièrement remboursé.")).toBeVisible();
    // Séjour maintenu et tout rendu : un remboursement ne crée jamais de « Reste à payer ».
    await expect(page.locator("[data-balance-due]")).toHaveCount(0);
    await expect(page.locator("[data-refund-due]")).toHaveCount(0);

    await expect.poll(() => refundMails().length).toBe(1);
    expect(mailSubject(refundMails()[0])).toMatch(/^Remboursement de 240,00 € pour votre réservation — /);
  });

  test("plusieurs remboursements partiels jusqu'au plafond ; dépassement refusé (UI et requête forgée) ; 0, négatif, texte refusés ; motif échappé", async ({ page }) => {
    test.setTimeout(60_000);
    const { dossierId } = await insertDossier([{ roomId: roomA, total: "300.00" }], { paid: "300.00" });
    let alerted = false;
    page.on("dialog", (d) => {
      alerted = true;
      void d.dismiss();
    });
    await page.goto(`/admin/dossiers/${dossierId}`);

    let dialog = await openRefund(page);
    await dialog.locator('input[name="amount"]').fill("100,50");
    await dialog.locator('textarea[name="reason"]').fill("<script>alert(1)</script> geste");
    await expect(dialog.locator("[data-refund-submit]")).toHaveText(/Rembourser 100,50\s€/);
    await dialog.locator("[data-refund-submit]").click();
    await expect(page).toHaveURL(/rembourse=1$/);
    await expect(page.locator("[data-refund-reason]")).toHaveText("<script>alert(1)</script> geste");

    dialog = await openRefund(page);
    await expect(dialog.locator("[data-refund-cap]")).toHaveText(/Au plus 199,50\s€\./);
    await dialog.locator('input[name="amount"]').fill("150");
    await dialog.locator("[data-refund-submit]").click();
    await expect(page.locator("[data-money-moves] li")).toHaveCount(3);

    // Montants impossibles : bouton bloqué et message, à chaque fois.
    dialog = await openRefund(page);
    const amount = dialog.locator('input[name="amount"]');
    const submit = dialog.locator("[data-refund-submit]");
    await amount.fill("50");
    await expect(dialog.locator("[data-refund-cap]")).toHaveText(/C'est plus que ce qui reste remboursable : 49,50\s€ au plus\./);
    await expect(submit).toBeDisabled();
    for (const bad of ["0", "-5", "12,345", "abc"]) {
      await amount.fill(bad);
      await expect(dialog.locator("[data-refund-cap]")).toContainText("Montant invalide");
      await expect(submit).toBeDisabled();
    }
    // Requête forgée (bouton réactivé à la main) : le serveur refuse le texte.
    await submit.evaluate((b) => b.removeAttribute("disabled"));
    await submit.click();
    await expect(dialog.getByRole("alert")).toHaveText("Saisissez un montant en euros supérieur à 0 (par exemple 45 ou 45,50).");
    // 50 € alors qu'il reste 49,50 € : message ; forgé, le serveur refuse aussi. Rien chez Stripe ni en base.
    await amount.fill("50");
    await expect(dialog.locator("[data-refund-cap]")).toHaveText(/C'est plus que ce qui reste remboursable : 49,50\s€ au plus\./);
    await submit.click();
    await expect(dialog.getByRole("alert")).toHaveText(/Le montant dépasse ce qui reste remboursable \(49,50\s€ au plus\)\./);
    expect((await refundsOf(dossierId)).map((r) => r.amount)).toEqual(["100.50", "150.00"]);
    expect(stripeCalls(dossierId)).toHaveLength(2);

    // Le reste exact passe ; ensuite plus rien à rembourser.
    await dialog.locator('[data-refund-shortcut="Tout le restant"]').click();
    await expect(amount).toHaveValue("49,50");
    await submit.click();
    await expect(page.locator("[data-money-moves] li")).toHaveCount(4);
    await expect(page.locator("[data-refund-open]")).toHaveCount(0);
    expect((await refundsOf(dossierId)).map((r) => r.amount)).toEqual(["100.50", "150.00", "49.50"]);
    expect(alerted).toBe(false);
    await expect.poll(() => refundMails().length).toBe(3);
  });

  test("annuler une chambre, case cochée : rembourse le prix de la chambre (rattaché à elle) ; trop-perçu recalculé", async ({ page }) => {
    const { dossierId, bookingIds } = await insertDossier(
      [
        { roomId: roomA, total: "180.00" },
        { roomId: roomB, total: "120.00" },
      ],
      { paid: "300.00" },
    );
    await page.goto(`/admin/dossiers/${dossierId}`);
    await page.locator(`[data-dossier-room="${bookingIds[1]}"]`).getByRole("button", { name: "Annuler cette chambre" }).click();
    const d = page.locator("dialog[open]");
    // Sans conditions acceptées au paiement : défaut = prix de la chambre.
    await expect(d.getByRole("checkbox", { name: /Rembourser/ })).toBeChecked();
    await expect(d.locator("[data-refund-label]")).toHaveText(/Rembourser 120\s€/);
    await confirmDialog(page);
    await expect(page).toHaveURL(/chambre-annulee=1&rembourse=1$/);
    expect(await refundsOf(dossierId)).toEqual([{ amount: "120.00", booking_id: bookingIds[1], reason: null, status: "succeeded" }]);
    await expect(page.locator("[data-money-moves]")).toContainText(`Remboursement · ${NAMES.b}`);
    await expect(page.locator("[data-refund-due]")).toHaveCount(0);
    await expect(page.locator("[data-net-paid]")).toHaveText(/^180\s€$/);
    await expect(page.locator("[data-balance-due]")).toHaveCount(0);
  });

  test("annuler une chambre, case décochée : rien remboursé ; « Rembourser » propose le trop-perçu", async ({ page }) => {
    const { dossierId, bookingIds } = await insertDossier(
      [
        { roomId: roomA, total: "180.00" },
        { roomId: roomB, total: "120.00" },
      ],
      { paid: "300.00" },
    );
    await page.goto(`/admin/dossiers/${dossierId}`);
    await page.locator(`[data-dossier-room="${bookingIds[1]}"]`).getByRole("button", { name: "Annuler cette chambre" }).click();
    await page.locator("dialog[open]").getByRole("checkbox", { name: /Rembourser/ }).uncheck();
    await expect(page.locator("dialog[open]")).toContainText("Rien ne sera remboursé");
    await confirmDialog(page);
    await expect(page).toHaveURL(/chambre-annulee=1$/);
    expect(await refundsOf(dossierId)).toEqual([]);
    expect(stripeCalls(dossierId)).toHaveLength(0);
    await expect(page.locator("[data-refund-due]")).toHaveText(/^120\s€$/);

    // Le trop-perçu est le montant proposé, avec le raccourci de la chambre annulée.
    const dialog = await openRefund(page);
    await expect(dialog.locator('input[name="amount"]')).toHaveValue("120");
    await expect(dialog.locator("[data-refund-shortcut]")).toHaveText([/120\s€ · Trop-perçu/, /300\s€ · Tout le restant/]);
    await dialog.locator("[data-refund-submit]").click();
    await expect(page).toHaveURL(/rembourse=1$/);
    await expect(page.locator("[data-refund-due]")).toHaveCount(0);
  });

  test("annuler tout le Dossier avec remboursement : tout est rendu, badge « Remboursé »", async ({ page }) => {
    const { dossierId } = await insertDossier([{ roomId: roomA, total: "200.00" }], { paid: "200.00" });
    await page.goto(`/admin/dossiers/${dossierId}`);
    await page.getByRole("button", { name: "Annuler tout le Dossier" }).click();
    await expect(page.locator("dialog[open] [data-refund-label]")).toHaveText(/Rembourser 200\s€/);
    await confirmDialog(page);
    await expect(page).toHaveURL(/annule=1&rembourse=1$/);
    expect(await refundsOf(dossierId)).toEqual([{ amount: "200.00", booking_id: null, reason: null, status: "succeeded" }]);
    await expect(page.getByText("Remboursé", { exact: true })).toBeVisible();
    await expect(page.locator("[data-refund-banner]")).toContainText("Remboursement de 200");
  });

  test("fiche réservation d'une chambre seule : annuler avec remboursement modifié", async ({ page }) => {
    const { dossierId, bookingIds } = await insertDossier([{ roomId: roomA, total: "200.00" }], { paid: "200.00" });
    await page.goto(`/admin/reservations/${bookingIds[0]}`);
    await page.getByRole("button", { name: "Annuler la réservation" }).click();
    const d = page.locator("dialog[open]");
    await d.locator('input[name="amount"]').fill("80");
    await expect(d.locator("[data-refund-label]")).toHaveText(/Rembourser 80\s€/);
    await confirmDialog(page);
    await expect(page).toHaveURL(/annulee=1&rembourse=1$/);
    await expect(page.locator("[data-refund-banner]")).toContainText("Remboursement de 80");
    expect(await refundsOf(dossierId)).toEqual([{ amount: "80.00", booking_id: bookingIds[0], reason: null, status: "succeeded" }]);
    // 120 € restent encaissés : le bandeau renvoie à la fiche du Dossier pour la suite.
    await expect(page.getByRole("link", { name: "Rembourser depuis la fiche du Dossier" })).toBeVisible();
  });

  test("montant de la case invalide ou trop élevé : le dialog reste ouvert, rien n'est annulé ni remboursé", async ({ page }) => {
    const { dossierId } = await insertDossier([{ roomId: roomA, total: "200.00" }], { paid: "200.00" });
    await page.goto(`/admin/dossiers/${dossierId}`);
    await page.getByRole("button", { name: "Annuler tout le Dossier" }).click();
    const d = page.locator("dialog[open]");
    await d.locator('input[name="amount"]').fill("250");
    await confirmDialog(page);
    await expect(d.getByRole("alert")).toHaveText(/Le montant dépasse ce qui reste remboursable \(200\s€ au plus\)\./);
    await d.locator('input[name="amount"]').fill("abc");
    await confirmDialog(page);
    await expect(d.getByRole("alert")).toContainText("Montant à rembourser invalide");
    expect((await pool.query("SELECT status FROM bookings WHERE dossier_id = $1", [dossierId])).rows).toEqual([{ status: "confirmed" }]);
    expect(await refundsOf(dossierId)).toEqual([]);
  });

  test("suggestion selon le niveau du Dossier : modérée à J-5 → 50 % ; personnalisé → total à vérifier", async ({ page }) => {
    const { dossierId } = await insertDossier([{ roomId: roomA, total: "300.00" }], {
      paid: "300.00",
      checkIn: parisDay(5),
      checkOut: parisDay(7),
      level: "moderate",
    });
    await page.goto(`/admin/dossiers/${dossierId}`);
    await page.getByRole("button", { name: "Annuler tout le Dossier" }).click();
    let d = page.locator("dialog[open]");
    await expect(d.locator('input[name="amount"]')).toHaveValue("150");
    await expect(d.locator('[data-refund-shortcut][aria-pressed="true"]')).toContainText("50 % selon vos conditions (modérée, moins de 7 jours)");
    await d.getByRole("button", { name: "Garder" }).click();

    await pool.query("UPDATE dossiers SET cancellation_level = 'custom' WHERE id = $1", [dossierId]);
    await page.goto(`/admin/dossiers/${dossierId}`);
    await page.getByRole("button", { name: "Annuler tout le Dossier" }).click();
    d = page.locator("dialog[open]");
    await expect(d.locator('input[name="amount"]')).toHaveValue("300");
    await expect(d.locator("[data-refund-note-custom]")).toHaveText("Conditions personnalisées, vérifiez le montant.");
    await d.getByRole("button", { name: "Garder" }).click();
    expect(await refundsOf(dossierId)).toEqual([]);
  });

  test("réglé hors ligne : ni bouton « Rembourser » ni case dans l'annulation", async ({ page }) => {
    const { dossierId } = await insertDossier([{ roomId: roomA, total: "200.00" }], { offline: true });
    await page.goto(`/admin/dossiers/${dossierId}`);
    await expect(page.getByText("Réglé", { exact: true })).toBeVisible();
    await expect(page.locator("[data-refund-open]")).toHaveCount(0);
    await page.getByRole("button", { name: "Annuler tout le Dossier" }).click();
    await expect(page.locator("dialog[open] [data-refund-note]")).toHaveText("Aucun paiement en ligne à rembourser.");
    await expect(page.locator("dialog[open] [data-refund-fields]")).toHaveCount(0);
  });

  test("Stripe en erreur : rien en base, message clair ; annulation + remboursement en erreur : annulation faite, bandeau", async ({ page }) => {
    const { dossierId } = await insertDossier([{ roomId: roomA, total: "200.00" }], { paid: "200.00" });
    await page.goto(`/admin/dossiers/${dossierId}`);
    stripe.refundError = { status: 400, message: "Charge already refunded" };
    let dialog = await openRefund(page);
    await dialog.locator('input[name="amount"]').fill("50");
    await dialog.locator("[data-refund-submit]").click();
    await expect(dialog.getByRole("alert")).toHaveText("Stripe a refusé le remboursement (« Charge already refunded ») : rien n'a été remboursé.");
    expect(await refundsOf(dossierId)).toEqual([]);

    stripe.refundError = { status: 500, message: "boom" };
    await page.goto(`/admin/dossiers/${dossierId}`);
    dialog = await openRefund(page);
    await dialog.locator('input[name="amount"]').fill("50");
    await dialog.locator("[data-refund-submit]").click();
    await expect(dialog.getByRole("alert")).toHaveText("Stripe est injoignable pour le moment : rien n'a été remboursé. Réessayez dans un instant.");
    expect(await refundsOf(dossierId)).toEqual([]);

    await page.goto(`/admin/dossiers/${dossierId}`);
    await page.getByRole("button", { name: "Annuler tout le Dossier" }).click();
    await confirmDialog(page);
    await expect(page).toHaveURL(/annule=1&rembourse=echec$/);
    await expect(page.locator("[data-refund-banner]")).toContainText("rien n'a été remboursé");
    expect((await pool.query("SELECT status FROM bookings WHERE dossier_id = $1", [dossierId])).rows).toEqual([{ status: "cancelled" }]);
    expect(await refundsOf(dossierId)).toEqual([]);
    expect(refundMails()).toHaveLength(0);
  });

  test("Stripe renvoie « en cours » : ligne « En cours », comptée dans le plafond", async ({ page }) => {
    stripe.refundStatus = "pending";
    const { dossierId } = await insertDossier([{ roomId: roomA, total: "100.00" }], { paid: "100.00" });
    await page.goto(`/admin/dossiers/${dossierId}`);
    const dialog = await openRefund(page);
    await dialog.locator('[data-refund-shortcut="Tout le restant"]').click();
    await dialog.locator("[data-refund-submit]").click();
    await expect(page.locator("[data-refund-banner]")).toContainText(/Remboursement de 100\s€ en cours/);
    await expect(page.locator("[data-money-moves]")).toContainText("En cours");
    await expect(page.locator("[data-refund-open]")).toHaveCount(0);
    expect((await refundsOf(dossierId))[0].status).toBe("pending");
  });
});
