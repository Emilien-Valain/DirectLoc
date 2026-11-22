import { test, expect } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { deleteOrphanDossiers } from "../helpers/dossier";
import { startFakeStripe, type FakeStripe } from "../helpers/fake-stripe";

/**
 * Litiges, logique serveur (`saveDisputeEvidence` / `acceptDispute`, `lib/disputes.ts`) :
 * isolation multi-tenant, double envoi refusé sous verrou, lecture seule après envoi ou date
 * limite, appels Stripe sur le compte connecté de l'hôtel (démo : plateforme, sans compte).
 * Sonde tsx en sous-processus ASYNCHRONE : le faux Stripe vit dans ce processus.
 */

const ctx = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "e2e", ".auth", "test-context.json"), "utf-8"),
) as { tenantId: string; apiRoomId: string; rivalTenantId: string; rivalRoomId: string };

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const STAMP = Date.now().toString(36);
const EMAIL = `dispute-isolation-${STAMP}@example.com`;
let stripe: FakeStripe;
let n = 0;

test.beforeAll(async () => {
  stripe = await startFakeStripe();
});

/** Dossier payé + litige ouvert ; ids du litige et du Dossier. */
async function insertDisputed(tenantId: string, roomId: string, dueInDays = 10) {
  const { rows } = await pool.query(
    `INSERT INTO dossiers (tenant_id, check_in, check_out, guest_name, guest_email)
     VALUES ($1, '2036-04-10', '2036-04-12', 'Litige isolation', $2) RETURNING id`,
    [tenantId, EMAIL],
  );
  const dossierId = rows[0].id as string;
  await pool.query(
    `INSERT INTO bookings (tenant_id, dossier_id, room_id, check_in, check_out, total_price, status, guest_name, guest_email, guest_count, source)
     VALUES ($1, $2, $3, '2036-04-10', '2036-04-12', '210.00', 'confirmed', 'Litige isolation', $4, 1, 'direct')`,
    [tenantId, dossierId, roomId, EMAIL],
  );
  const p = await pool.query(
    `INSERT INTO payments (tenant_id, dossier_id, stripe_session_id, stripe_payment_id, amount, currency, status)
     VALUES ($1, $2, $3, $4, '210.00', 'eur', 'paid') RETURNING id`,
    [tenantId, dossierId, `cs_test_dispute_iso_${STAMP}_${++n}`, `pi_test_dispute_iso_${STAMP}_${n}`],
  );
  const d = await pool.query(
    `INSERT INTO disputes (tenant_id, dossier_id, payment_id, stripe_dispute_id, amount, reason, status, evidence_due_by)
     VALUES ($1, $2, $3, $4, '210.00', 'fraudulent', 'needs_response', now() + ($5 || ' days')::interval) RETURNING id`,
    [tenantId, dossierId, p.rows[0].id, `dp_iso_${STAMP}_${n}`, String(dueInDays)],
  );
  return { disputeId: d.rows[0].id as string, stripeId: `dp_iso_${STAMP}_${n}`, dossierId };
}

const row = async (id: string) =>
  (await pool.query("SELECT status, evidence, submitted_at, closed_at FROM disputes WHERE id = $1", [id])).rows[0];

async function cleanup(extra: string[] = []) {
  const { rows } = await pool.query("SELECT id FROM dossiers WHERE guest_email = $1", [EMAIL]);
  const ids = rows.map((r) => r.id as string);
  await pool.query("DELETE FROM disputes WHERE dossier_id = ANY($1::uuid[])", [ids]);
  await pool.query("DELETE FROM payments WHERE dossier_id = ANY($1::uuid[])", [ids]);
  await pool.query("DELETE FROM bookings WHERE dossier_id = ANY($1::uuid[])", [ids]);
  await pool.query("DELETE FROM dossiers WHERE id = ANY($1::uuid[])", [ids]);
  for (const sql of extra) await pool.query(sql);
  await deleteOrphanDossiers(pool);
}

test.afterAll(async () => {
  await stripe.close();
  await cleanup();
  expect(Number((await pool.query("SELECT count(*) FROM dossiers WHERE guest_email = $1", [EMAIL])).rows[0].count)).toBe(0);
  await pool.end();
});

const probe = (args: string[], env: Record<string, string> = {}) =>
  promisify(execFile)("npx", ["tsx", path.join(__dirname, "dispute-isolation-probe.ts"), ...args], {
    encoding: "utf8",
    timeout: 45_000,
    env: { ...process.env, STRIPE_SECRET_KEY: "sk_test_placeholder", STRIPE_API_BASE: "http://localhost:3995", DEMO_TENANT_SLUG: "", ...env },
  });

test("litige : autre tenant introuvable, double envoi refusé, lecture seule après envoi / date limite, compte connecté", async () => {
  test.setTimeout(60_000);
  const own = await insertDisputed(ctx.tenantId, ctx.apiRoomId);
  const toAccept = await insertDisputed(ctx.tenantId, ctx.apiRoomId);
  const pastDue = await insertDisputed(ctx.tenantId, ctx.apiRoomId, -1);
  const rival = await insertDisputed(ctx.rivalTenantId, ctx.rivalRoomId);
  await pool.query("UPDATE tenants SET stripe_account_id = 'acct_test_e2e_rival' WHERE id = $1", [ctx.rivalTenantId]);
  const before = await row(rival.disputeId);

  const { stdout } = await probe([ctx.tenantId, own.disputeId, rival.disputeId, toAccept.disputeId, pastDue.disputeId]);
  await pool.query("UPDATE tenants SET stripe_account_id = NULL WHERE id = $1", [ctx.rivalTenantId]);
  const r = JSON.parse(stdout.trim().split("\n").pop()!);

  // Isolation : rien chez B, ni en base ni chez Stripe.
  for (const k of ["rivalDraft", "rivalSubmit", "rivalAccept", "badId"]) expect(r[k]).toEqual({ error: "DisputeActionError: Litige introuvable." });
  expect(r.rivalRead).toBeNull();
  expect(await row(rival.disputeId)).toEqual(before);
  expect(stripe.disputes.filter((x) => x.id === rival.stripeId)).toHaveLength(0);

  // Brouillon puis un seul envoi.
  expect(r.draft).toEqual({ ok: { status: "needs_response", submitted: false } });
  expect(r.concurrent.filter((x: string) => x === "ok")).toHaveLength(1);
  expect(r.concurrent.find((x: string) => x !== "ok")).toBe("DisputeActionError: La réponse a déjà été envoyée à la banque : elle ne se modifie plus.");
  expect(r.afterSubmitDraft.error).toMatch(/déjà été envoyée/);
  expect(r.afterSubmitAccept.error).toMatch(/déjà été envoyée/);
  const mine = stripe.disputes.filter((x) => x.id === own.stripeId);
  expect(mine.map((x) => [x.action, x.params.submit])).toEqual([["update", "false"], ["update", "true"]]);
  for (const x of mine) expect(x.stripeAccount).toBe("acct_test_e2e_main");
  expect(mine[0].params["evidence[customer_name]"]).toBe("Jeanne");
  expect(mine[0].params["evidence[uncategorized_text]"]).toBe("Note");
  expect(mine[0].params["evidence[product_description]"]).toBe("");
  expect(mine[0].params["evidence[receipt]"]).toBeUndefined();
  const saved = await row(own.disputeId);
  expect(saved.status).toBe("under_review");
  expect(saved.submitted_at).not.toBeNull();
  expect(saved.evidence).toEqual({ customer_name: "Jeanne" });

  // Accepter : close sur le compte de l'hôtel, perdu ; une seconde fois refusé.
  expect(r.accept).toEqual({ ok: { status: "lost" } });
  expect(r.acceptAgain.error).toBe("DisputeActionError: Ce litige est clos.");
  expect(stripe.disputes.filter((x) => x.id === toAccept.stripeId).map((x) => [x.action, x.stripeAccount])).toEqual([["close", "acct_test_e2e_main"]]);
  expect((await row(toAccept.disputeId)).closed_at).not.toBeNull();

  // Date limite dépassée : refus, rien chez Stripe.
  expect(r.pastDue.error).toMatch(/date limite de réponse est dépassée/);
  expect(stripe.disputes.filter((x) => x.id === pastDue.stripeId)).toHaveLength(0);
});

test("démo : preuves envoyées en mode test sur la plateforme, sans en-tête Stripe-Account", async () => {
  test.setTimeout(60_000);
  const existing = await pool.query("SELECT id, stripe_account_id FROM tenants WHERE slug = 'demo-tenant'");
  let demoId: string = existing.rows[0]?.id;
  const created = !demoId;
  if (created) demoId = (await pool.query("INSERT INTO tenants (name, slug) VALUES ('Hôtel Démo', 'demo-tenant') RETURNING id")).rows[0].id;
  await pool.query("UPDATE tenants SET stripe_account_id = 'acct_test_e2e_demo_ignored' WHERE id = $1", [demoId]);
  const propertyId = (await pool.query("INSERT INTO properties (tenant_id, name) VALUES ($1, 'Litige démo') RETURNING id", [demoId])).rows[0].id;
  const roomId = (
    await pool.query(
      `INSERT INTO rooms (tenant_id, property_id, name, slug, price_per_night, capacity)
       VALUES ($1, $2, 'Chambre litige démo', $3, '100.00', 2) RETURNING id`,
      [demoId, propertyId, `dispute-demo-${STAMP}`],
    )
  ).rows[0].id;
  try {
    const d = await insertDisputed(demoId, roomId);
    const out = JSON.parse((await probe(["demo", demoId, d.disputeId], { DEMO_TENANT_SLUG: "demo-tenant" })).stdout.trim().split("\n").pop()!);
    expect(out).toEqual({ ok: { status: "needs_response", submitted: false } });
    const call = stripe.disputes.find((x) => x.id === d.stripeId)!;
    expect(call.stripeAccount).toBeUndefined();
  } finally {
    await cleanup([`DELETE FROM rooms WHERE id = '${roomId}'`, `DELETE FROM properties WHERE id = '${propertyId}'`]);
    if (created) await pool.query("DELETE FROM tenants WHERE id = $1", [demoId]);
    else await pool.query("UPDATE tenants SET stripe_account_id = $2 WHERE id = $1", [demoId, existing.rows[0].stripe_account_id]);
  }
});
