import { test, expect, type APIRequestContext } from "@playwright/test";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { Pool } from "pg";
import { deleteOrphanDossiers } from "../helpers/dossier";
import { confirmDialog } from "../helpers/confirm";
import { startFakeStripe, type FakeStripe } from "../helpers/fake-stripe";
import { startSmtpSink } from "../helpers/smtp-sink";
import { mailBody, mailSubject } from "../helpers/mail-body";

/**
 * Spécification : Tests de non-régression > Admin > Litiges
 * Issue `.scratch/remboursements-litiges/issues/04-disputes.md`.
 *
 * Événements `charge.dispute.created|updated|closed` signés (secret Connect pour l'hôtel, secret
 * plateforme pour la démo) : alerte unique aux admins, bandeau de la fiche Dossier, marque dans la
 * liste ; réponse (brouillon, envoi définitif, double envoi), acceptation, clôture gagnée / perdue
 * (argent recalculé), date limite dépassée, remboursement bloqué, ordre inversé, isolation, démo,
 * XSS dans les preuves. Stripe simulé, SMTP capté.
 * Logique serveur et isolation des actions : `e2e/unit/dispute-isolation.spec.ts`.
 */

const BASE_URL = "http://localhost:3001";
const PLATFORM_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? "whsec_test_XXXX";
const CONNECT_SECRET = process.env.STRIPE_CONNECT_WEBHOOK_SECRET!;
const MAIN_ACCOUNT = "acct_test_e2e_main";

const ctx = JSON.parse(fs.readFileSync(path.join(process.cwd(), "e2e", ".auth", "test-context.json"), "utf-8")) as {
  tenantId: string;
  apiRoomId: string;
  rivalTenantId: string;
};
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const STAMP = Date.now().toString(36);
const EMAIL = `disputes-${STAMP}@example.com`;
const RIVAL_ACCOUNT = `acct_rival_dp_${STAMP}`;
const CANCELLATION = `Annulation gratuite jusqu'à 7 jours avant l'arrivée ${STAMP}.`;
let stripe: FakeStripe;
let sink: Awaited<ReturnType<typeof startSmtpSink>>;
let mainAccountBefore: string | null;
let rivalAccountBefore: string | null;
let seq = 0;
const uid = (p: string) => `${p}_${STAMP}_${++seq}`;

const sign = (payload: string, secret: string) => {
  const t = Math.floor(Date.now() / 1000);
  return `t=${t},v1=${crypto.createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex")}`;
};

type Opts = { account?: string | null; livemode?: boolean; secret?: string };
/** Envoie un événement signé ; par défaut : endpoint Connect, compte de l'hôtel principal. */
async function send(request: APIRequestContext, type: string, object: unknown, o: Opts = {}) {
  const account = o.account === undefined ? MAIN_ACCOUNT : o.account;
  const payload = JSON.stringify({
    id: uid("evt"),
    type,
    livemode: o.livemode ?? false,
    created: Math.floor(Date.now() / 1000),
    ...(account ? { account } : {}),
    data: { object },
  });
  return request.post(`${BASE_URL}/api/webhooks/stripe`, {
    data: payload,
    headers: { "content-type": "application/json", "stripe-signature": sign(payload, o.secret ?? (account ? CONNECT_SECRET : PLATFORM_SECRET)) },
  });
}

const DAY = 86_400_000;
const inDays = (n: number) => new Date(Date.now() + n * DAY);
const ddmm = (d: Date) => d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", timeZone: "Europe/Paris" });
const disputeObj = (
  id: string,
  pi: string,
  amountCents: number,
  status = "needs_response",
  o: { dueBy?: Date; reason?: string; submissions?: number } = {},
) => ({
  id,
  object: "dispute",
  amount: amountCents,
  currency: "eur",
  payment_intent: pi,
  charge: `ch_${id}`,
  reason: o.reason ?? "fraudulent",
  status,
  evidence_details: {
    due_by: Math.floor((o.dueBy ?? inDays(10)).getTime() / 1000),
    has_evidence: false,
    past_due: false,
    submission_count: o.submissions ?? 0,
  },
});

/** Dossier payé en ligne (une chambre confirmée), conditions acceptées au paiement. */
async function insertPaid(tenantId: string, roomId: string | null, paid = "200.00", guest = `Voyageur Litige ${STAMP}`) {
  const pi = uid("pi_test_dp");
  const { rows } = await pool.query(
    `INSERT INTO dossiers (tenant_id, check_in, check_out, guest_name, guest_email, accepted_cancellation_text, accepted_cgv_text, terms_accepted_at, cancellation_level)
     VALUES ($1, '2036-09-10', '2036-09-12', $2, $3, $4, 'CGV', now() - interval '20 days', 'moderate') RETURNING id`,
    [tenantId, guest, EMAIL, CANCELLATION],
  );
  const dossierId = rows[0].id as string;
  if (roomId) {
    await pool.query(
      `INSERT INTO bookings (tenant_id, dossier_id, room_id, check_in, check_out, total_price, status, guest_name, guest_email, guest_count, source)
       VALUES ($1, $2, $3, '2036-09-10', '2036-09-12', $4, 'confirmed', $5, $6, 2, 'direct')`,
      [tenantId, dossierId, roomId, paid, guest, EMAIL],
    );
  }
  await pool.query(
    `INSERT INTO payments (tenant_id, dossier_id, stripe_session_id, stripe_payment_id, amount, currency, status) VALUES ($1, $2, $3, $4, $5, 'eur', 'paid')`,
    [tenantId, dossierId, uid("cs_test_dp"), pi, paid],
  );
  return { dossierId, pi, guest };
}

const rowsOf = async (dossierId: string) =>
  (await pool.query("SELECT stripe_dispute_id, amount, reason, status, submitted_at, closed_at, evidence FROM disputes WHERE dossier_id = $1 ORDER BY created_at", [dossierId])).rows;
const alertMails = () => sink.mails.filter((m) => mailSubject(m).startsWith("Litige :"));
const adminCount = async (tenantId: string) =>
  (await pool.query("SELECT count(*)::int AS n FROM user_tenants WHERE tenant_id = $1", [tenantId])).rows[0].n as number;

async function cleanup() {
  const { rows } = await pool.query("SELECT id FROM dossiers WHERE guest_email = $1", [EMAIL]);
  const ids = rows.map((r) => r.id as string);
  await pool.query("DELETE FROM disputes WHERE dossier_id = ANY($1::uuid[])", [ids]);
  await pool.query("DELETE FROM refunds WHERE dossier_id = ANY($1::uuid[])", [ids]);
  await pool.query("DELETE FROM payments WHERE dossier_id = ANY($1::uuid[])", [ids]);
  await pool.query("DELETE FROM bookings WHERE dossier_id = ANY($1::uuid[])", [ids]);
  await pool.query("DELETE FROM dossiers WHERE id = ANY($1::uuid[])", [ids]);
  await deleteOrphanDossiers(pool);
}

test.describe("Admin — Litiges", () => {
  test.beforeAll(async () => {
    stripe = await startFakeStripe();
    sink = await startSmtpSink();
    mainAccountBefore = (await pool.query("SELECT stripe_account_id FROM tenants WHERE id = $1", [ctx.tenantId])).rows[0].stripe_account_id;
    await pool.query("UPDATE tenants SET stripe_account_id = $2 WHERE id = $1", [ctx.tenantId, MAIN_ACCOUNT]);
    rivalAccountBefore = (await pool.query("SELECT stripe_account_id FROM tenants WHERE id = $1", [ctx.rivalTenantId])).rows[0].stripe_account_id;
    await pool.query("UPDATE tenants SET stripe_account_id = $2 WHERE id = $1", [ctx.rivalTenantId, RIVAL_ACCOUNT]);
  });
  test.beforeEach(() => {
    sink.mails.length = 0;
    stripe.disputes.length = 0;
    stripe.disputeError = null;
  });
  test.afterEach(cleanup);
  test.afterAll(async () => {
    await cleanup();
    await pool.query("UPDATE tenants SET stripe_account_id = $2 WHERE id = $1", [ctx.tenantId, mainAccountBefore]);
    await pool.query("UPDATE tenants SET stripe_account_id = $2 WHERE id = $1", [ctx.rivalTenantId, rivalAccountBefore]);
    expect((await pool.query("SELECT count(*)::int AS n FROM dossiers WHERE guest_email = $1", [EMAIL])).rows[0].n).toBe(0);
    await stripe.close();
    await sink.stop();
    await pool.end();
  });

  test("création par webhook : une alerte par admin (re-livraison comprise), bandeau rouge, marque dans la liste, remboursement bloqué", async ({ request, page }) => {
    const d = await insertPaid(ctx.tenantId, ctx.apiRoomId, "200.00");
    const due = inDays(9);
    const dp = disputeObj(uid("dp"), d.pi, 15000, "needs_response", { dueBy: due, reason: "product_not_received" });
    expect((await send(request, "charge.dispute.created", dp)).status()).toBe(200);
    expect((await send(request, "charge.dispute.created", dp)).status()).toBe(200);
    expect((await send(request, "charge.dispute.updated", dp)).status()).toBe(200);
    expect(await rowsOf(d.dossierId)).toMatchObject([{ stripe_dispute_id: dp.id, amount: "150.00", reason: "product_not_received", status: "needs_response" }]);

    const admins = await adminCount(ctx.tenantId);
    expect(admins).toBeGreaterThan(0);
    await expect.poll(() => alertMails().length).toBe(admins);
    const mail = alertMails()[0];
    expect(mailSubject(mail)).toContain(`150,00 € contestés par ${d.guest}`);
    expect(mailSubject(mail)).toContain(`réponse avant le ${ddmm(due)}`);
    expect(mailBody(mail)).toContain("<strong>séjour non fourni</strong>");

    await page.goto(`/admin/dossiers/${d.dossierId}`);
    const banner = page.locator('[data-dispute-banner="needs_response"]');
    await expect(banner).toContainText(`Litige en cours : 150 €, réponse avant le ${ddmm(due)}.`);
    await expect(banner).toContainText("séjour non fourni");
    await expect(page.locator("[data-dispute-card]")).toContainText("Les réservations ne changent pas.");
    await expect(page.locator("[data-dispute-stripe-link]")).toHaveAttribute("href", `https://dashboard.stripe.com/disputes/${dp.id}`);
    await expect(page.locator("[data-refund-open]")).toBeDisabled();
    await expect(page.locator("[data-refund-actions]")).toContainText("Litige en cours, répondez-y d'abord.");
    // La réservation ne bouge pas.
    expect((await pool.query("SELECT status FROM bookings WHERE dossier_id = $1", [d.dossierId])).rows[0].status).toBe("confirmed");

    await page.goto(`/admin/reservations?q=${encodeURIComponent(d.guest)}`);
    const tag = page.locator("[data-dispute-tag]");
    await expect(tag).toHaveCount(1);
    await tag.click();
    await expect(page).toHaveURL(new RegExp(`/admin/dossiers/${d.dossierId}$`));
  });

  test("répondre : préremplie, brouillon enregistré chez Stripe, envoi définitif ; second envoi (autre onglet) refusé ; lecture seule", async ({ request, page, context }) => {
    const d = await insertPaid(ctx.tenantId, ctx.apiRoomId, "200.00");
    const dp = disputeObj(uid("dp"), d.pi, 20000);
    await send(request, "charge.dispute.created", dp);

    await page.goto(`/admin/dossiers/${d.dossierId}`);
    await page.locator("[data-dispute-respond]").click();
    await expect(page).toHaveURL(new RegExp(`/admin/dossiers/${d.dossierId}/litige$`));
    await expect(page.locator('[data-evidence="product_description"]')).toHaveValue(/Séjour à .* du 10 septembre 2036 au 12 septembre 2036 \(2 nuits\)/);
    await expect(page.locator('[data-evidence="customer_name"]')).toHaveValue(d.guest);
    await expect(page.locator('[data-evidence="customer_email_address"]')).toHaveValue(EMAIL);
    await expect(page.locator('[data-evidence="cancellation_policy_disclosure"]')).toHaveValue(new RegExp(`acceptées par le voyageur au paiement le[\\s\\S]*${STAMP}`));
    await expect(page.locator('[data-evidence="access_activity_log"]')).toHaveValue(/Confirmation de réservation envoyée par email/);

    await page.locator('[data-evidence="refund_refusal_explanation"]').fill("Annulation hors délai, conditions acceptées.");
    await page.locator('[data-evidence="customer_name"]').fill("");
    await page.locator("[data-dispute-draft]").click();
    await expect(page.locator("[data-dispute-saved]")).toBeVisible();
    // Champs contrôlés : la saisie reste après l'action.
    await expect(page.locator('[data-evidence="refund_refusal_explanation"]')).toHaveValue("Annulation hors délai, conditions acceptées.");
    expect(stripe.disputes).toHaveLength(1);
    expect(stripe.disputes[0]).toMatchObject({ id: dp.id, action: "update", stripeAccount: MAIN_ACCOUNT });
    expect(stripe.disputes[0].params.submit).toBe("false");
    expect(stripe.disputes[0].params["evidence[refund_refusal_explanation]"]).toBe("Annulation hors délai, conditions acceptées.");
    expect(stripe.disputes[0].params["evidence[customer_name]"]).toBe("");
    const [saved] = await rowsOf(d.dossierId);
    expect(saved.submitted_at).toBeNull();
    expect(saved.evidence.refund_refusal_explanation).toBe("Annulation hors délai, conditions acceptées.");
    expect(saved.evidence.customer_name).toBeUndefined();

    // Brouillon relu à la réouverture (pas le préremplissage).
    const other = await context.newPage();
    await other.goto(`/admin/dossiers/${d.dossierId}/litige`);
    await expect(other.locator('[data-evidence="customer_name"]')).toHaveValue("");

    await page.locator("[data-dispute-send]").click();
    await expect(page.locator("dialog[open]")).toContainText("définitif");
    await page.locator("[data-dispute-confirm]").click();
    await expect(page).toHaveURL(new RegExp(`/admin/dossiers/${d.dossierId}\\?litige=envoye$`));
    await expect(page.locator("[data-dispute-flash]")).toContainText("Réponse envoyée à la banque");
    await expect(page.locator('[data-dispute-banner="under_review"]')).toContainText("réponse envoyée le");
    expect(stripe.disputes.map((x) => x.params.submit)).toEqual(["false", "true"]);
    expect((await rowsOf(d.dossierId))[0]).toMatchObject({ status: "under_review" });
    expect((await rowsOf(d.dossierId))[0].submitted_at).not.toBeNull();

    // L'autre onglet, resté ouvert, tente un second envoi : refusé, rien de plus chez Stripe.
    await other.locator("[data-dispute-send]").click();
    await other.locator("[data-dispute-confirm]").click();
    await expect(other.locator("[data-dispute-error]")).toContainText("déjà été envoyée");
    expect(stripe.disputes).toHaveLength(2);
    await other.close();

    await page.goto(`/admin/dossiers/${d.dossierId}/litige`);
    await expect(page.locator("[data-dispute-readonly]")).toContainText("Réponse envoyée à la banque");
    await expect(page.locator("[data-dispute-form]")).toHaveCount(0);
    await expect(page.locator("[data-dispute-evidence-readonly]")).toContainText("Annulation hors délai, conditions acceptées.");
  });

  test("Stripe refuse le brouillon : message, rien d'enregistré", async ({ request, page }) => {
    const d = await insertPaid(ctx.tenantId, ctx.apiRoomId);
    await send(request, "charge.dispute.created", disputeObj(uid("dp"), d.pi, 5000));
    stripe.disputeError = { status: 400, message: "Evidence too long" };
    await page.goto(`/admin/dossiers/${d.dossierId}/litige`);
    await page.locator("[data-dispute-draft]").click();
    await expect(page.locator("[data-dispute-error]")).toContainText("Stripe a refusé (« Evidence too long »)");
    expect((await rowsOf(d.dossierId))[0].evidence).toEqual({});
  });

  test("accepter : confirmation, close sur le compte de l'hôtel, « Litige perdu », encaissé net recalculé, réservation inchangée", async ({ request, page }) => {
    const d = await insertPaid(ctx.tenantId, ctx.apiRoomId, "200.00");
    const dp = disputeObj(uid("dp"), d.pi, 20000);
    await send(request, "charge.dispute.created", dp);
    await page.goto(`/admin/dossiers/${d.dossierId}`);
    await page.locator("[data-dispute-card] button", { hasText: "Accepter le litige" }).click();
    await expect(page.locator("dialog[open]")).toContainText("définitif");
    await confirmDialog(page);
    await expect(page).toHaveURL(new RegExp(`\\?litige=accepte$`));
    expect(stripe.disputes).toEqual([{ id: dp.id, action: "close", params: {}, stripeAccount: MAIN_ACCOUNT }]);
    await expect(page.locator('[data-dispute-banner="lost"]')).toContainText("Litige perdu : 200 € repris par la banque.");
    await expect(page.locator("[data-net-paid]")).toContainText("0 €");
    await expect(page.locator("[data-money-moves]")).toContainText("Litige perdu · repris par la banque");
    await expect(page.locator("[data-dispute-card]")).toHaveCount(0);
    expect((await pool.query("SELECT status FROM bookings WHERE dossier_id = $1", [d.dossierId])).rows[0].status).toBe("confirmed");
    // Le webhook de clôture qui suit ne change rien.
    await send(request, "charge.dispute.closed", disputeObj(dp.id, d.pi, 20000, "lost"));
    expect(await rowsOf(d.dossierId)).toHaveLength(1);
  });

  test("clôture par webhook : perdu → compté comme remboursé ; gagné → « Litige gagné », remboursement rouvert, disparu après 30 jours", async ({ request, page }) => {
    const lost = await insertPaid(ctx.tenantId, ctx.apiRoomId, "300.00");
    const dpLost = disputeObj(uid("dp"), lost.pi, 12000);
    await send(request, "charge.dispute.created", dpLost);
    await send(request, "charge.dispute.closed", { ...dpLost, status: "lost" });
    expect((await rowsOf(lost.dossierId))[0].closed_at).not.toBeNull();
    await page.goto(`/admin/dossiers/${lost.dossierId}`);
    await expect(page.locator('[data-dispute-banner="lost"]')).toContainText("Litige perdu : 120 € repris par la banque.");
    await expect(page.locator("[data-net-paid]")).toContainText("180 €");
    // Le plafond de remboursement tient compte de la reprise.
    await expect(page.locator("[data-refund-open]")).toBeEnabled();
    await page.locator("[data-refund-open]").click();
    await expect(page.locator("[data-refund-dialog] [data-refund-cap]")).toContainText("Au plus 180 €");
    await page.keyboard.press("Escape");

    const won = await insertPaid(ctx.tenantId, ctx.apiRoomId, "200.00");
    const dpWon = disputeObj(uid("dp"), won.pi, 20000);
    await send(request, "charge.dispute.created", dpWon);
    await send(request, "charge.dispute.updated", { ...dpWon, status: "under_review" });
    await send(request, "charge.dispute.closed", { ...dpWon, status: "won" });
    await page.goto(`/admin/dossiers/${won.dossierId}`);
    await expect(page.locator('[data-dispute-banner="won"]')).toContainText("Litige gagné : 200 € vous restent acquis.");
    await expect(page.locator("[data-refund-open]")).toBeEnabled();
    await expect(page.locator("[data-money-moves]")).not.toContainText("Litige perdu");
    await page.goto(`/admin/reservations?q=${encodeURIComponent(won.guest)}`);
    await expect(page.locator("[data-dispute-tag]")).toHaveCount(0);

    await pool.query("UPDATE disputes SET closed_at = now() - interval '31 days' WHERE stripe_dispute_id = $1", [dpWon.id]);
    await page.goto(`/admin/dossiers/${won.dossierId}`);
    await expect(page.locator("[data-dossier]")).toBeVisible();
    await expect(page.locator("[data-dispute-banner]")).toHaveCount(0);
  });

  test("date limite dépassée : bandeau, fiche sans « Accepter », page de réponse en lecture seule", async ({ request, page }) => {
    const d = await insertPaid(ctx.tenantId, ctx.apiRoomId);
    const due = inDays(-1);
    await send(request, "charge.dispute.created", disputeObj(uid("dp"), d.pi, 5000, "needs_response", { dueBy: due }));
    await page.goto(`/admin/dossiers/${d.dossierId}`);
    await expect(page.locator('[data-dispute-banner="needs_response"]')).toContainText(`date limite de réponse dépassée (${ddmm(due)})`);
    await expect(page.locator("[data-dispute-card] button", { hasText: "Accepter" })).toHaveCount(0);
    await expect(page.locator("[data-dispute-respond]")).toHaveText("Voir la réponse");
    await page.locator("[data-dispute-respond]").click();
    await expect(page.locator("[data-dispute-readonly]")).toContainText("Date limite dépassée");
    await expect(page.locator("[data-dispute-form]")).toHaveCount(0);
    // Préremplissage montré en lecture seule.
    await expect(page.locator("[data-dispute-evidence-readonly]")).toContainText(d.guest);
  });

  test("ordre inversé et re-livraison : un litige clos ne se rouvre pas, pas d'alerte ; réponse faite dans Stripe → lecture seule", async ({ request, page }) => {
    const d = await insertPaid(ctx.tenantId, ctx.apiRoomId);
    const dp = disputeObj(uid("dp"), d.pi, 5000);
    await send(request, "charge.dispute.closed", { ...dp, status: "lost" });
    await send(request, "charge.dispute.created", dp);
    await send(request, "charge.dispute.updated", { ...dp, status: "under_review" });
    expect(await rowsOf(d.dossierId)).toMatchObject([{ status: "lost" }]);
    expect(alertMails()).toHaveLength(0);

    const d2 = await insertPaid(ctx.tenantId, ctx.apiRoomId);
    const dp2 = disputeObj(uid("dp"), d2.pi, 5000);
    await send(request, "charge.dispute.updated", { ...dp2, status: "under_review", evidence_details: { ...dp2.evidence_details, submission_count: 1 } });
    await send(request, "charge.dispute.created", dp2);
    const [r] = await rowsOf(d2.dossierId);
    expect(r.status).toBe("under_review");
    expect(r.submitted_at).not.toBeNull();
    await page.goto(`/admin/dossiers/${d2.dossierId}/litige`);
    await expect(page.locator("[data-dispute-readonly]")).toContainText("Réponse envoyée");
  });

  test("isolation : un autre compte connecté, un compte inconnu ou la plateforme visant le paiement de l'hôtel → rien ; et inversement", async ({ request }) => {
    const mine = await insertPaid(ctx.tenantId, ctx.apiRoomId);
    const theirs = await insertPaid(ctx.rivalTenantId, null);
    expect((await send(request, "charge.dispute.created", disputeObj(uid("dp"), mine.pi, 100), { account: RIVAL_ACCOUNT })).status()).toBe(200);
    expect((await send(request, "charge.dispute.created", disputeObj(uid("dp"), mine.pi, 100), { account: "acct_inconnu" })).status()).toBe(200);
    expect((await send(request, "charge.dispute.created", disputeObj(uid("dp"), mine.pi, 100), { account: null })).status()).toBe(200);
    expect((await send(request, "charge.dispute.created", disputeObj(uid("dp"), theirs.pi, 100))).status()).toBe(200);
    expect((await send(request, "charge.dispute.created", disputeObj(uid("dp"), "pi_inexistant", 100))).status()).toBe(200);
    expect((await send(request, "charge.dispute.created", { id: uid("dp"), object: "dispute" })).status()).toBe(200);
    expect((await send(request, "charge.dispute.created", disputeObj(uid("dp"), mine.pi, 100), { secret: "whsec_pas_le_bon" })).status()).toBe(400);

    // Un litige de l'hôtel ne peut pas être « repris » par un autre compte avec le même id.
    const dp = disputeObj(uid("dp"), mine.pi, 100);
    await send(request, "charge.dispute.created", dp);
    await send(request, "charge.dispute.closed", { ...dp, payment_intent: theirs.pi, status: "won" }, { account: RIVAL_ACCOUNT });
    expect(await rowsOf(mine.dossierId)).toMatchObject([{ stripe_dispute_id: dp.id, status: "needs_response" }]);
    expect(await rowsOf(theirs.dossierId)).toHaveLength(0);
    expect(alertMails().length).toBe(await adminCount(ctx.tenantId));
  });

  test("démo : événement test de la plateforme accepté sans email ; live ou compte connecté ignoré", async ({ request }) => {
    const demo = (await pool.query("SELECT id FROM tenants WHERE slug = 'demo-tenant'")).rows[0]?.id as string | undefined;
    test.skip(!demo, "tenant démo absent");
    const room = (await pool.query("SELECT id FROM rooms WHERE tenant_id = $1 LIMIT 1", [demo])).rows[0].id as string;
    const d = await insertPaid(demo!, room);
    const dp = disputeObj(uid("dp"), d.pi, 3000);
    await send(request, "charge.dispute.created", dp, { account: null, livemode: true });
    await send(request, "charge.dispute.created", dp, { account: MAIN_ACCOUNT });
    expect(await rowsOf(d.dossierId)).toHaveLength(0);
    await send(request, "charge.dispute.created", dp, { account: null });
    expect(await rowsOf(d.dossierId)).toMatchObject([{ status: "needs_response", amount: "30.00" }]);
    await new Promise((r) => setTimeout(r, 500));
    expect(sink.mails).toHaveLength(0);
  });

  test("XSS dans les preuves : enregistré tel quel, affiché échappé en lecture seule, aucun dialog", async ({ request, page }) => {
    const d = await insertPaid(ctx.tenantId, ctx.apiRoomId);
    await send(request, "charge.dispute.created", disputeObj(uid("dp"), d.pi, 5000));
    let dialogs = 0;
    page.on("dialog", async (dlg) => {
      dialogs++;
      await dlg.dismiss();
    });
    const xss = `<script>alert(1)</script><img src=x onerror=alert(2)>`;
    await page.goto(`/admin/dossiers/${d.dossierId}/litige`);
    await page.locator('[data-evidence="uncategorized_text"]').fill(xss);
    await page.locator("[data-dispute-send]").click();
    await page.locator("[data-dispute-confirm]").click();
    await expect(page).toHaveURL(/\?litige=envoye$/);
    expect(stripe.disputes[0].params["evidence[uncategorized_text]"]).toBe(xss);
    await page.goto(`/admin/dossiers/${d.dossierId}/litige`);
    await expect(page.locator("[data-dispute-evidence-readonly]")).toContainText(xss);
    await expect(page.locator("[data-dispute-evidence-readonly] img")).toHaveCount(0);
    expect(dialogs).toBe(0);
  });

  test("page de réponse : Dossier inconnu, sans litige ou d'un autre tenant → 404", async ({ page }) => {
    const mine = await insertPaid(ctx.tenantId, ctx.apiRoomId);
    const theirs = await insertPaid(ctx.rivalTenantId, null);
    const pay = (await pool.query("SELECT id FROM payments WHERE dossier_id = $1", [theirs.dossierId])).rows[0].id;
    await pool.query(
      `INSERT INTO disputes (tenant_id, dossier_id, payment_id, stripe_dispute_id, amount, reason, status) VALUES ($1, $2, $3, $4, '10.00', 'general', 'needs_response')`,
      [ctx.rivalTenantId, theirs.dossierId, pay, uid("dp")],
    );
    for (const url of [
      `/admin/dossiers/${mine.dossierId}/litige`,
      `/admin/dossiers/${theirs.dossierId}/litige`,
      `/admin/dossiers/00000000-0000-4000-8000-000000000000/litige`,
      `/admin/dossiers/pas-un-uuid/litige`,
    ]) {
      expect((await page.goto(url))?.status(), url).toBe(404);
    }
  });
});

