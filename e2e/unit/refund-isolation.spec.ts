import { test, expect } from "@playwright/test";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { deleteOrphanDossiers } from "../helpers/dossier";
import { startFakeStripe, type FakeStripe } from "../helpers/fake-stripe";
import { startSmtpSink } from "../helpers/smtp-sink";
import { mailBody, mailSubject } from "../helpers/mail-body";

/**
 * Remboursements, logique serveur (`refundDossierPayment` / `checkRefund`, `lib/dossier-admin.ts`) :
 * isolation multi-tenant, plafond contrôlé côté serveur (montants forgés, concurrence),
 * idempotence d'une soumission, refus hors ligne, Refund créé sur le compte connecté.
 *
 * Les arguments liés des server actions sont chiffrés par Next : on teste la logique qu'elles
 * appellent via une sonde tsx (comme `dossier-isolation.spec.ts`). La sonde tourne en
 * sous-processus ASYNCHRONE : le faux Stripe vit dans ce processus et doit pouvoir répondre.
 */

const ctx = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "e2e", ".auth", "test-context.json"), "utf-8"),
) as { tenantId: string; apiRoomId: string; rivalTenantId: string; rivalRoomId: string };

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const STAMP = Date.now().toString(36);
const EMAIL = `refund-isolation-${STAMP}@example.com`;
let stripe: FakeStripe;

test.beforeAll(async () => {
  stripe = await startFakeStripe();
});

async function snapshot(dossierId: string) {
  const q = async (sql: string) => (await pool.query(sql, [dossierId])).rows;
  return {
    dossier: await q("SELECT * FROM dossiers WHERE id = $1"),
    bookings: await q("SELECT * FROM bookings WHERE dossier_id = $1 ORDER BY id"),
    payments: await q("SELECT * FROM payments WHERE dossier_id = $1 ORDER BY id"),
    refunds: await q("SELECT * FROM refunds WHERE dossier_id = $1 ORDER BY id"),
  };
}

async function insertDossier(tenantId: string, roomId: string, payment: { amount: string; status: string } | null) {
  const { rows } = await pool.query(
    `INSERT INTO dossiers (tenant_id, check_in, check_out, guest_name, guest_email)
     VALUES ($1, '2036-04-10', '2036-04-12', 'Remboursement isolation', $2) RETURNING id`,
    [tenantId, EMAIL],
  );
  const dossierId = rows[0].id as string;
  const b = await pool.query(
    `INSERT INTO bookings (tenant_id, dossier_id, room_id, check_in, check_out, total_price, status, guest_name, guest_email, guest_count, source, paid_at)
     VALUES ($1, $2, $3, '2036-04-10', '2036-04-12', '210.00', 'confirmed', 'Remboursement isolation', $4, 1, $5, $6) RETURNING id`,
    [tenantId, dossierId, roomId, EMAIL, payment ? "direct" : "manual", payment ? null : new Date()],
  );
  if (payment) {
    await pool.query(
      `INSERT INTO payments (tenant_id, dossier_id, stripe_session_id, stripe_payment_id, amount, currency, status)
       VALUES ($1, $2, $3, $4, $5, 'eur', $6)`,
      [tenantId, dossierId, `cs_test_refund_iso_${STAMP}_${Math.random()}`, `pi_test_refund_iso_${STAMP}_${Math.random()}`, payment.amount, payment.status],
    );
  }
  return { dossierId, bookingId: b.rows[0].id as string };
}

test.afterAll(async () => {
  await stripe.close();
  const { rows } = await pool.query("SELECT id FROM dossiers WHERE guest_email = $1", [EMAIL]);
  const ids = rows.map((r) => r.id as string);
  await pool.query("DELETE FROM refunds WHERE dossier_id = ANY($1::uuid[])", [ids]);
  await pool.query("DELETE FROM payments WHERE dossier_id = ANY($1::uuid[])", [ids]);
  await pool.query("DELETE FROM bookings WHERE dossier_id = ANY($1::uuid[])", [ids]);
  await pool.query("DELETE FROM dossiers WHERE id = ANY($1::uuid[])", [ids]);
  await deleteOrphanDossiers(pool);
  const left = await pool.query(
    "SELECT (SELECT count(*) FROM dossiers WHERE guest_email = $1) + (SELECT count(*) FROM bookings WHERE guest_email = $1) AS n",
    [EMAIL],
  );
  expect(Number(left.rows[0].n)).toBe(0);
  await pool.end();
});

test("remboursement : autre tenant introuvable, plafond serveur, idempotence, hors ligne refusé, compte connecté", async () => {
  test.setTimeout(60_000);
  const own = await insertDossier(ctx.tenantId, ctx.apiRoomId, { amount: "210.00", status: "paid" });
  const offline = await insertDossier(ctx.tenantId, ctx.apiRoomId, null);
  const rival = await insertDossier(ctx.rivalTenantId, ctx.rivalRoomId, { amount: "210.00", status: "paid" });
  // Le tenant rival a un compte connecté : s'il était utilisé, l'en-tête le trahirait.
  await pool.query("UPDATE tenants SET stripe_account_id = 'acct_test_e2e_rival' WHERE id = $1", [ctx.rivalTenantId]);
  const before = await snapshot(rival.dossierId);

  const { stdout } = await promisify(execFile)(
    "npx",
    [
      "tsx",
      path.join(__dirname, "refund-isolation-probe.ts"),
      ctx.tenantId,
      own.dossierId,
      rival.dossierId,
      rival.bookingId,
      offline.dossierId,
      ...Array.from({ length: 7 }, () => randomUUID()),
    ],
    {
      encoding: "utf8",
      timeout: 45_000,
      env: { ...process.env, STRIPE_SECRET_KEY: "sk_test_placeholder", STRIPE_API_BASE: "http://localhost:3995", DEMO_TENANT_SLUG: "" },
    },
  );
  await pool.query("UPDATE tenants SET stripe_account_id = NULL WHERE id = $1", [ctx.rivalTenantId]);
  const r = JSON.parse(stdout.trim().split("\n").pop()!);

  // Isolation : rien chez B, ni en base ni chez Stripe.
  expect(r.rivalRefund).toEqual({ error: "DossierActionError: Dossier introuvable." });
  expect(r.rivalCheck).toEqual({ error: "DossierActionError: Dossier introuvable." });
  expect(await snapshot(rival.dossierId)).toEqual(before);
  expect(stripe.refunds.filter((x) => x.params["metadata[dossierId]"] === rival.dossierId)).toHaveLength(0);

  // Montants forgés : refusés avant tout appel Stripe.
  expect(r.zero.error).toBe("DossierActionError: Saisissez un montant supérieur à 0 €.");
  expect(r.negative.error).toBe("DossierActionError: Saisissez un montant supérieur à 0 €.");
  expect(r.fractional.error).toBe("DossierActionError: Saisissez un montant supérieur à 0 €.");
  expect(r.tooMuch.error).toMatch(/^DossierActionError: Le montant dépasse ce qui reste remboursable \(210\s€ au plus\)\.$/);
  expect(r.badRequestId.error).toBe("DossierActionError: Formulaire expiré : rechargez la page.");
  expect(r.offline.error).toMatch(/^DossierActionError: Aucun paiement en ligne à rembourser/);
  expect(r.offlineCheck.error).toMatch(/^DossierActionError: Aucun paiement en ligne à rembourser/);

  // Chambre d'un autre tenant en bookingId : ignorée ; motif nettoyé.
  expect(r.forgedBooking).toEqual({ ok: { id: "<id>", amount: 50, status: "succeeded", created: true } });
  expect(r.replay).toEqual({ ok: { id: "<id>", amount: 50, status: "succeeded", created: false } });
  expect(r.concurrent.filter((x: string) => x === "ok")).toHaveLength(1);
  expect(r.concurrent.find((x: string) => x !== "ok")).toMatch(/dépasse ce qui reste remboursable \(60\s€ au plus\)/);
  expect(r.rest).toEqual({ ok: { id: "<id>", amount: 60, status: "succeeded", created: true } });
  expect(r.afterFull.error).toBe("DossierActionError: Ce paiement est déjà entièrement remboursé.");

  const rows = (
    await pool.query("SELECT amount, booking_id, reason, status, stripe_refund_id FROM refunds WHERE dossier_id = $1 ORDER BY created_at", [own.dossierId])
  ).rows;
  expect(rows.map((x) => x.amount)).toEqual(["50.00", "100.00", "60.00"]);
  expect(rows[0]).toMatchObject({ booking_id: null, reason: "Geste", status: "succeeded" });
  expect(rows.every((x) => /^re_fake_/.test(x.stripe_refund_id))).toBe(true);

  // Chez Stripe : sur le compte connecté de l'hôtel A, payment_intent du Dossier, clé d'idempotence par soumission.
  const mine = stripe.refunds.filter((x) => x.params["metadata[dossierId]"] === own.dossierId);
  // 50 €, 100 €, 60 € : le rejeu est trouvé en base, le second simultané est refusé sous verrou, avant Stripe.
  expect(mine.map((x) => x.params.amount)).toEqual(["5000", "10000", "6000"]);
  for (const x of mine) {
    expect(x.stripeAccount).toBe("acct_test_e2e_main");
    expect(x.params.payment_intent).toMatch(/^pi_test_refund_iso_/);
    expect(x.params["metadata[tenantId]"]).toBe(ctx.tenantId);
    expect(x.params["metadata[bookingId]"]).toBeUndefined();
    expect(x.idempotencyKey).toMatch(new RegExp(`^refund_${own.dossierId}_[0-9a-f-]{36}$`));
  }
});

test("démo : Refund en test sur la plateforme (sans Stripe-Account) et aucun email ; hôtel normal : email au voyageur", async () => {
  test.setTimeout(60_000);
  const sink = await startSmtpSink();
  const existing = await pool.query("SELECT id, stripe_account_id FROM tenants WHERE slug = 'demo-tenant'");
  let demoId: string = existing.rows[0]?.id;
  const created = !demoId;
  if (created) demoId = (await pool.query("INSERT INTO tenants (name, slug) VALUES ('Hôtel Démo', 'demo-tenant') RETURNING id")).rows[0].id;
  // Compte posé exprès : la démo doit l'ignorer.
  await pool.query("UPDATE tenants SET stripe_account_id = 'acct_test_e2e_demo_ignored' WHERE id = $1", [demoId]);
  const propertyId = (await pool.query("INSERT INTO properties (tenant_id, name) VALUES ($1, 'Remboursement démo') RETURNING id", [demoId])).rows[0].id;
  const roomId = (
    await pool.query(
      `INSERT INTO rooms (tenant_id, property_id, name, slug, price_per_night, capacity)
       VALUES ($1, $2, 'Chambre remboursement démo', $3, '100.00', 2) RETURNING id`,
      [demoId, propertyId, `refund-demo-${STAMP}`],
    )
  ).rows[0].id;
  const probe = (tenant: string, dossier: string) =>
    promisify(execFile)("npx", ["tsx", path.join(__dirname, "refund-isolation-probe.ts"), "demo", tenant, dossier, randomUUID()], {
      encoding: "utf8",
      timeout: 45_000,
      env: {
        ...process.env,
        STRIPE_SECRET_KEY: "sk_test_placeholder",
        STRIPE_API_BASE: "http://localhost:3995",
        DEMO_TENANT_SLUG: "demo-tenant",
        SMTP_HOST: "localhost",
        SMTP_PORT: "1025",
        SMTP_SECURE: "false",
        SMTP_USER: "",
        SMTP_PASS: "",
      },
    });
  try {
    const demo = await insertDossier(demoId, roomId, { amount: "100.00", status: "paid" });
    const out = JSON.parse((await probe(demoId, demo.dossierId)).stdout.trim().split("\n").pop()!);
    expect(out).toEqual({ status: "succeeded", created: true, emailed: true });
    const call = stripe.refunds.find((x) => x.params["metadata[dossierId]"] === demo.dossierId)!;
    expect(call.stripeAccount).toBeUndefined();
    expect(call.params.amount).toBe("2500");

    const own = await insertDossier(ctx.tenantId, ctx.apiRoomId, { amount: "100.00", status: "paid" });
    await probe(ctx.tenantId, own.dossierId);
    expect(stripe.refunds.find((x) => x.params["metadata[dossierId]"] === own.dossierId)!.stripeAccount).toBe("acct_test_e2e_main");
    await expect.poll(() => sink.mails.filter((m) => m.to.includes(EMAIL)).length).toBe(1);
    const mail = sink.mails.find((m) => m.to.includes(EMAIL))!;
    expect(mailSubject(mail)).toMatch(/^Remboursement de 25,00 € pour votre réservation — /);
    expect(mailBody(mail)).toContain("5 &agrave; 10 jours");
  } finally {
    await sink.stop();
    const { rows } = await pool.query("SELECT id FROM dossiers WHERE tenant_id = $1 AND guest_email = $2", [demoId, EMAIL]);
    const ids = rows.map((r) => r.id as string);
    await pool.query("DELETE FROM refunds WHERE dossier_id = ANY($1::uuid[])", [ids]);
    await pool.query("DELETE FROM payments WHERE dossier_id = ANY($1::uuid[])", [ids]);
    await pool.query("DELETE FROM bookings WHERE dossier_id = ANY($1::uuid[])", [ids]);
    await pool.query("DELETE FROM dossiers WHERE id = ANY($1::uuid[])", [ids]);
    await pool.query("DELETE FROM rooms WHERE id = $1", [roomId]);
    await pool.query("DELETE FROM properties WHERE id = $1", [propertyId]);
    if (created) await pool.query("DELETE FROM tenants WHERE id = $1", [demoId]);
    else await pool.query("UPDATE tenants SET stripe_account_id = $2 WHERE id = $1", [demoId, existing.rows[0].stripe_account_id]);
  }
});
