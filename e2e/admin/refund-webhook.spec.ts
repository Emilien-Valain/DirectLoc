import { test, expect } from "@playwright/test";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { Pool } from "pg";
import { deleteOrphanDossiers } from "../helpers/dossier";
import { startFakeStripe, type FakeStripe } from "../helpers/fake-stripe";
import { startSmtpSink } from "../helpers/smtp-sink";
import { mailSubject } from "../helpers/mail-body";

/**
 * Spécification : Tests de non-régression > Admin > Remboursements (synchro webhook)
 * Issue `.scratch/remboursements-litiges/issues/03-refund-webhook-sync.md`.
 *
 * Événements `charge.refunded` / `refund.created|updated|failed` signés (secret Connect pour
 * l'hôtel, secret plateforme pour la démo), envoyés au webhook : statut des remboursements de
 * l'app, remboursements faits dans le tableau de bord Stripe, échec, idempotence, ordre inversé,
 * isolation entre comptes connectés, démo. Stripe simulé, SMTP capté.
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
const EMAIL = `refund-hook-${STAMP}@example.com`;
const RIVAL_ACCOUNT = `acct_rival_${STAMP}`;
let stripe: FakeStripe;
let sink: Awaited<ReturnType<typeof startSmtpSink>>;
let rivalAccountBefore: string | null;
let mainAccountBefore: string | null;
let seq = 0;
const uid = (p: string) => `${p}_${STAMP}_${++seq}`;

const sign = (payload: string, secret: string) => {
  const t = Math.floor(Date.now() / 1000);
  return `t=${t},v1=${crypto.createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex")}`;
};

type Opts = { account?: string | null; livemode?: boolean; secret?: string; created?: number };
/** Envoie un événement signé ; par défaut : endpoint Connect, compte de l'hôtel principal. */
async function send(request: import("@playwright/test").APIRequestContext, type: string, object: unknown, o: Opts = {}) {
  const account = o.account === undefined ? MAIN_ACCOUNT : o.account;
  const payload = JSON.stringify({
    id: uid("evt"),
    type,
    livemode: o.livemode ?? false,
    created: o.created ?? Math.floor(Date.now() / 1000),
    ...(account ? { account } : {}),
    data: { object },
  });
  return request.post(`${BASE_URL}/api/webhooks/stripe`, {
    data: payload,
    headers: { "content-type": "application/json", "stripe-signature": sign(payload, o.secret ?? (account ? CONNECT_SECRET : PLATFORM_SECRET)) },
  });
}
const refundObj = (id: string, pi: string, amountCents: number, status = "succeeded", extra: Record<string, unknown> = {}) => ({
  id, object: "refund", amount: amountCents, currency: "eur", payment_intent: pi, status,
  failure_reason: status === "failed" ? "expired_or_canceled_card" : null, metadata: {}, ...extra,
});

/** Dossier payé en ligne (une chambre confirmée) ; renvoie ses ids. */
async function insertPaid(tenantId: string, roomId: string | null, paid = "200.00") {
  const pi = uid("pi_test_hook");
  const { rows } = await pool.query(
    `INSERT INTO dossiers (tenant_id, check_in, check_out, guest_name, guest_email) VALUES ($1, '2036-07-10', '2036-07-12', 'Voyageur Hook', $2) RETURNING id`,
    [tenantId, EMAIL],
  );
  const dossierId = rows[0].id as string;
  if (roomId) {
    await pool.query(
      `INSERT INTO bookings (tenant_id, dossier_id, room_id, check_in, check_out, total_price, status, guest_name, guest_email, guest_count, source)
       VALUES ($1, $2, $3, '2036-07-10', '2036-07-12', $4, 'confirmed', 'Voyageur Hook', $5, 2, 'direct')`,
      [tenantId, dossierId, roomId, paid, EMAIL],
    );
  }
  const p = await pool.query(
    `INSERT INTO payments (tenant_id, dossier_id, stripe_session_id, stripe_payment_id, amount, currency, status) VALUES ($1, $2, $3, $4, $5, 'eur', 'paid') RETURNING id`,
    [tenantId, dossierId, uid("cs_test_hook"), pi, paid],
  );
  return { dossierId, pi, paymentId: p.rows[0].id as string };
}
/** Remboursement créé par l'app (ligne déjà écrite). */
async function insertAppRefund(d: { dossierId: string; paymentId: string; tenantId?: string }, reId: string, amount: string, status = "pending") {
  await pool.query(
    `INSERT INTO refunds (tenant_id, dossier_id, payment_id, amount, status, stripe_refund_id, idempotency_key) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [d.tenantId ?? ctx.tenantId, d.dossierId, d.paymentId, amount, status, reId, `refund_${d.dossierId}_${reId}`],
  );
}
const rowsOf = async (dossierId: string) =>
  (await pool.query("SELECT amount, status, reason, failure_reason, stripe_refund_id, idempotency_key FROM refunds WHERE dossier_id = $1 ORDER BY stripe_refund_id", [dossierId])).rows;
const guestMails = () => sink.mails.filter((m) => m.to.includes(EMAIL) && mailSubject(m).startsWith("Remboursement de"));
const adminMails = () => sink.mails.filter((m) => mailSubject(m).includes("échoué"));

async function cleanup() {
  const { rows } = await pool.query("SELECT id FROM dossiers WHERE guest_email = $1", [EMAIL]);
  const ids = rows.map((r) => r.id as string);
  await pool.query("DELETE FROM refunds WHERE dossier_id = ANY($1::uuid[])", [ids]);
  await pool.query("DELETE FROM payments WHERE dossier_id = ANY($1::uuid[])", [ids]);
  await pool.query("DELETE FROM bookings WHERE dossier_id = ANY($1::uuid[])", [ids]);
  await pool.query("DELETE FROM dossiers WHERE id = ANY($1::uuid[])", [ids]);
  await deleteOrphanDossiers(pool);
}

test.describe("Admin — Remboursements : synchro webhook", () => {
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
    stripe.listedRefunds = [];
    stripe.refundLists.length = 0;
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

  test("remboursement de l'app en cours → refund.updated l'effectue : même ligne, pas de doublon, pas d'email voyageur", async ({ request }) => {
    const d = await insertPaid(ctx.tenantId, ctx.apiRoomId);
    await insertAppRefund(d, "re_app_1", "50.00");
    const res = await send(request, "refund.updated", refundObj("re_app_1", d.pi, 5000, "succeeded", { metadata: { dossierId: d.dossierId, tenantId: ctx.tenantId } }));
    expect(res.status()).toBe(200);
    expect(await rowsOf(d.dossierId)).toMatchObject([{ stripe_refund_id: "re_app_1", status: "succeeded", amount: "50.00" }]);
    expect(guestMails()).toHaveLength(0);
  });

  test("re-livraison et ordre inversé : un effectué ne repasse pas « en cours », une seule ligne", async ({ request }) => {
    const d = await insertPaid(ctx.tenantId, ctx.apiRoomId);
    await insertAppRefund(d, "re_app_2", "50.00");
    const done = refundObj("re_app_2", d.pi, 5000, "succeeded", { metadata: { dossierId: d.dossierId } });
    await send(request, "refund.updated", done);
    await send(request, "refund.updated", done);
    expect((await send(request, "refund.created", refundObj("re_app_2", d.pi, 5000, "pending", { metadata: { dossierId: d.dossierId } }))).status()).toBe(200);
    expect(await rowsOf(d.dossierId)).toMatchObject([{ status: "succeeded" }]);
    expect(guestMails()).toHaveLength(0);
  });

  test("remboursement fait dans Stripe : nouvelle ligne « Remboursé depuis Stripe », email voyageur une seule fois, argent recalculé", async ({ request, page }) => {
    const d = await insertPaid(ctx.tenantId, ctx.apiRoomId, "200.00");
    const r = refundObj("re_dash_1", d.pi, 7550);
    expect((await send(request, "refund.created", r)).status()).toBe(200);
    expect((await send(request, "refund.updated", r)).status()).toBe(200);
    expect((await send(request, "charge.refunded", { id: "ch_1", object: "charge", payment_intent: d.pi, refunds: { data: [r] } })).status()).toBe(200);
    expect(await rowsOf(d.dossierId)).toEqual([
      { amount: "75.50", status: "succeeded", reason: "Remboursé depuis Stripe", failure_reason: null, stripe_refund_id: "re_dash_1", idempotency_key: "stripe_re_dash_1" },
    ]);
    expect(guestMails()).toHaveLength(1);

    await page.goto(`/admin/dossiers/${d.dossierId}`);
    await expect(page.locator("[data-money-moves]")).toContainText("75,50");
    await expect(page.locator("[data-money-moves]")).toContainText("Remboursé depuis Stripe");
    await expect(page.locator("[data-refund-failed]")).toHaveCount(0);
  });

  test("charge.refunded : chaque Refund de la liste est traité (app + Stripe) ; sans liste, elle est relue chez Stripe sur le compte de l'hôtel", async ({ request }) => {
    const d = await insertPaid(ctx.tenantId, ctx.apiRoomId, "300.00");
    await insertAppRefund(d, "re_app_3", "40.00");
    const list = [refundObj("re_app_3", d.pi, 4000, "succeeded", { metadata: { dossierId: d.dossierId } }), refundObj("re_dash_2", d.pi, 1000)];
    await send(request, "charge.refunded", { object: "charge", payment_intent: d.pi, refunds: { data: list } });
    expect((await rowsOf(d.dossierId)).map((x) => [x.stripe_refund_id, x.status])).toEqual([["re_app_3", "succeeded"], ["re_dash_2", "succeeded"]]);
    expect(guestMails()).toHaveLength(1);

    stripe.listedRefunds = [refundObj("re_dash_3", d.pi, 2500)];
    await send(request, "charge.refunded", { object: "charge", payment_intent: d.pi });
    expect(stripe.refundLists).toHaveLength(1);
    expect(stripe.refundLists[0].stripeAccount).toBe(MAIN_ACCOUNT);
    expect((await rowsOf(d.dossierId)).map((x) => x.stripe_refund_id)).toEqual(["re_app_3", "re_dash_2", "re_dash_3"]);
    expect(guestMails()).toHaveLength(2);
  });

  test("échec d'un remboursement de l'app : ligne « échoué », bandeau rouge sur la fiche, un seul email aux admins", async ({ request, page }) => {
    const d = await insertPaid(ctx.tenantId, ctx.apiRoomId);
    await insertAppRefund(d, "re_app_4", "60.00");
    const failed = refundObj("re_app_4", d.pi, 6000, "failed", { metadata: { dossierId: d.dossierId } });
    await send(request, "refund.updated", failed);
    await send(request, "refund.failed", failed);
    await send(request, "refund.updated", failed);
    expect(await rowsOf(d.dossierId)).toMatchObject([{ status: "failed", failure_reason: "expired_or_canceled_card" }]);
    const admins = (await pool.query("SELECT u.email FROM user_tenants ut JOIN users u ON u.id = ut.user_id WHERE ut.tenant_id = $1", [ctx.tenantId])).rows.length;
    expect(admins).toBeGreaterThan(0);
    expect(adminMails()).toHaveLength(admins);
    expect(guestMails()).toHaveLength(0);

    await page.goto(`/admin/dossiers/${d.dossierId}`);
    const banner = page.locator("[data-refund-failed]");
    await expect(banner).toContainText("60");
    await expect(banner).toContainText("échoué");
    await expect(banner).toContainText("expired_or_canceled_card");
  });

  test("échec reçu d'abord pour un remboursement venu de Stripe : ligne échouée, alerte admin, pas d'email voyageur ; puis effectué sans régression ni doublon", async ({ request }) => {
    const d = await insertPaid(ctx.tenantId, ctx.apiRoomId);
    await send(request, "refund.updated", refundObj("re_dash_4", d.pi, 3000, "failed"));
    expect(await rowsOf(d.dossierId)).toMatchObject([{ status: "failed" }]);
    expect(adminMails().length).toBeGreaterThan(0);
    expect(guestMails()).toHaveLength(0);
    const before = adminMails().length;
    // Stripe réessaie et réussit : la ligne devient effectuée (pas de seconde alerte).
    await send(request, "refund.updated", refundObj("re_dash_4", d.pi, 3000, "succeeded"));
    expect(await rowsOf(d.dossierId)).toMatchObject([{ status: "succeeded", failure_reason: null }]);
    expect(adminMails()).toHaveLength(before);
  });

  test("remboursement de l'app dont la ligne n'est pas encore écrite : 503 (Stripe rejoue), puis créée si l'événement est ancien", async ({ request }) => {
    const d = await insertPaid(ctx.tenantId, ctx.apiRoomId);
    const meta = { dossierId: d.dossierId, tenantId: ctx.tenantId };
    const r = refundObj("re_app_5", d.pi, 2000, "succeeded", { metadata: meta });
    expect((await send(request, "refund.created", r)).status()).toBe(503);
    expect(await rowsOf(d.dossierId)).toHaveLength(0);
    expect((await send(request, "refund.created", r, { created: Math.floor(Date.now() / 1000) - 600 })).status()).toBe(200);
    expect(await rowsOf(d.dossierId)).toHaveLength(1);
  });

  test("isolation : un autre compte connecté, ou aucun compte, visant le paiement de l'hôtel → rien ne bouge ; et inversement", async ({ request }) => {
    const mine = await insertPaid(ctx.tenantId, ctx.apiRoomId);
    const theirs = await insertPaid(ctx.rivalTenantId, null);
    await insertAppRefund(mine, "re_app_6", "10.00");
    const r = (pi: string, id = "re_x_1") => refundObj(id, pi, 9999);

    // Compte du rival visant le paiement de l'hôtel principal.
    expect((await send(request, "refund.created", r(mine.pi), { account: RIVAL_ACCOUNT })).status()).toBe(200);
    expect((await send(request, "charge.refunded", { object: "charge", payment_intent: mine.pi, refunds: { data: [r(mine.pi)] } }, { account: RIVAL_ACCOUNT })).status()).toBe(200);
    // Compte de l'hôtel principal visant le paiement du rival.
    expect((await send(request, "refund.created", r(theirs.pi, "re_x_2"))).status()).toBe(200);
    // Compte inconnu ; événement plateforme (sans compte) sur un hôtel non démo.
    expect((await send(request, "refund.created", r(mine.pi), { account: "acct_inconnu" })).status()).toBe(200);
    expect((await send(request, "refund.updated", refundObj("re_app_6", mine.pi, 1000, "failed"), { account: RIVAL_ACCOUNT })).status()).toBe(200);
    expect((await send(request, "refund.created", r(mine.pi), { account: null, secret: PLATFORM_SECRET })).status()).toBe(200);

    expect(await rowsOf(mine.dossierId)).toMatchObject([{ stripe_refund_id: "re_app_6", status: "pending" }]);
    expect(await rowsOf(theirs.dossierId)).toHaveLength(0);
    expect(sink.mails).toHaveLength(0);
  });

  test("payment_intent inconnu, absent ou malformé → 200, rien créé ; signature invalide ou absente → 400", async ({ request }) => {
    expect((await send(request, "refund.created", refundObj("re_ghost", "pi_inexistant", 100))).status()).toBe(200);
    expect((await send(request, "charge.refunded", { object: "charge", payment_intent: null })).status()).toBe(200);
    expect((await send(request, "refund.updated", { id: "re_bad" })).status()).toBe(200);
    expect((await send(request, "refund.created", refundObj("re_ghost2", "pi_x", 100), { secret: "whsec_pas_le_bon" })).status()).toBe(400);
    const nosig = await request.post(`${BASE_URL}/api/webhooks/stripe`, { data: "{}", headers: { "content-type": "application/json" } });
    expect(nosig.status()).toBe(400);
    expect((await pool.query("SELECT count(*)::int AS n FROM refunds WHERE stripe_refund_id LIKE 're_ghost%' OR stripe_refund_id = 're_bad'")).rows[0].n).toBe(0);
  });

  test("démo : événement test de la plateforme accepté sans email ; événement live ou avec un compte connecté ignoré", async ({ request }) => {
    const demo = (await pool.query("SELECT id FROM tenants WHERE slug = 'demo-tenant'")).rows[0]?.id as string | undefined;
    test.skip(!demo, "tenant démo absent");
    const room = (await pool.query("SELECT id FROM rooms WHERE tenant_id = $1 LIMIT 1", [demo])).rows[0].id as string;
    const d = await insertPaid(demo!, room);
    const ok = refundObj("re_demo_1", d.pi, 2000);

    expect((await send(request, "refund.created", ok, { account: null, livemode: true })).status()).toBe(200);
    expect((await send(request, "refund.created", ok, { account: MAIN_ACCOUNT })).status()).toBe(200);
    expect(await rowsOf(d.dossierId)).toHaveLength(0);

    expect((await send(request, "refund.created", ok, { account: null })).status()).toBe(200);
    expect((await send(request, "refund.created", ok, { account: null })).status()).toBe(200);
    expect(await rowsOf(d.dossierId)).toMatchObject([{ stripe_refund_id: "re_demo_1", status: "succeeded", amount: "20.00" }]);
    // Démo : jamais d'email, même pour un échec.
    await send(request, "refund.updated", refundObj("re_demo_1", d.pi, 2000, "failed"), { account: null });
    expect(await rowsOf(d.dossierId)).toMatchObject([{ status: "failed" }]);
    expect(sink.mails).toHaveLength(0);
  });
});
