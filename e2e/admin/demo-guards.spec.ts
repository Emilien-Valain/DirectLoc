import { test, expect, type Browser, type Page } from "@playwright/test";
import crypto from "crypto";
import { Pool } from "pg";
import { deleteOrphanDossiers, insertDossier } from "../helpers/dossier";
import { hashPassword } from "better-auth/crypto";
import { startSmtpSink } from "../helpers/smtp-sink";

/**
 * Spécification : Tests de non-régression > Admin > Garde-fous du tenant démo
 * Référence : .scratch/demo-mode/issues/01-demo-guards.md
 *
 * L'admin démo est ouvert à tous : emails, Stripe Connect, uploads, reset password
 * et slug/domaine sont bloqués côté serveur pour `demo-tenant` (DEMO_TENANT_SLUG
 * du webServer). Le tenant `test-tenant` doit garder tout.
 *
 * Connexion : un admin dédié au spec (mot de passe connu) est rattaché au tenant
 * démo, qu'il ait été seedé par global-setup (issue 02) ou créé ici. Tout ce que
 * le spec crée est supprimé en afterAll.
 */

const DEMO = "http://demo-tenant.localhost:3001";
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? "whsec_test_XXXX";
const PASSWORD = "demo-guards-password-123";
const EMAIL = `demo-guards-${Date.now()}@example.com`;
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function stripeSignature(payload: string): string {
  const t = Math.floor(Date.now() / 1000);
  const v1 = crypto.createHmac("sha256", WEBHOOK_SECRET).update(`${t}.${payload}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

test.describe.configure({ mode: "serial" });

let pool: Pool;
let demoTenantId: string;
let createdTenant = false;
let propertyId: string;
let roomId: string;
let userId: string;

test.beforeAll(async () => {
  pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });

  const existing = await pool.query("SELECT id FROM tenants WHERE slug = 'demo-tenant'");
  if (existing.rows[0]) {
    demoTenantId = existing.rows[0].id;
  } else {
    const { rows } = await pool.query(
      "INSERT INTO tenants (name, slug) VALUES ('Hôtel Démo', 'demo-tenant') RETURNING id",
    );
    demoTenantId = rows[0].id;
    createdTenant = true;
  }

  // Chambre propre au spec : la réservation ne dépend pas du jeu démo.
  propertyId = (
    await pool.query("INSERT INTO properties (tenant_id, name) VALUES ($1, 'Demo guards') RETURNING id", [demoTenantId])
  ).rows[0].id;
  roomId = (
    await pool.query(
      `INSERT INTO rooms (tenant_id, property_id, name, slug, price_per_night, capacity)
       VALUES ($1, $2, 'Chambre garde-fous', $3, '100.00', 2) RETURNING id`,
      [demoTenantId, propertyId, `demo-guards-${Date.now()}`],
    )
  ).rows[0].id;

  userId = crypto.randomBytes(16).toString("base64url");
  await pool.query("INSERT INTO users (id, name, email, email_verified) VALUES ($1, 'Demo Guards', $2, true)", [userId, EMAIL]);
  await pool.query(
    "INSERT INTO accounts (id, account_id, provider_id, user_id, password) VALUES ($1, $2, 'credential', $2, $3)",
    [crypto.randomBytes(16).toString("base64url"), userId, await hashPassword(PASSWORD)],
  );
  await pool.query("INSERT INTO user_tenants (user_id, tenant_id) VALUES ($1, $2)", [userId, demoTenantId]);
});

test.afterAll(async () => {
  await pool.query("DELETE FROM payments WHERE dossier_id IN (SELECT dossier_id FROM bookings WHERE room_id = $1)", [roomId]);
  await pool.query("DELETE FROM bookings WHERE room_id = $1", [roomId]);
  await deleteOrphanDossiers(pool);
  await pool.query("DELETE FROM rooms WHERE id = $1", [roomId]);
  await pool.query("DELETE FROM properties WHERE id = $1", [propertyId]);
  await pool.query("DELETE FROM users WHERE id = $1", [userId]); // cascade : sessions, accounts, user_tenants
  if (createdTenant) await pool.query("DELETE FROM tenants WHERE id = $1", [demoTenantId]);
  await pool.end();
});

async function demoAdmin(browser: Browser): Promise<Page> {
  const page = await (await browser.newContext({ storageState: { cookies: [], origins: [] } })).newPage();
  await page.goto(`${DEMO}/login`);
  await page.fill('[name="email"]', EMAIL);
  await page.fill('[name="password"]', PASSWORD);
  await Promise.all([page.waitForURL(/\/admin/), page.click('button[type="submit"]')]);
  return page;
}

test.describe("Démo — refus serveur", () => {
  test("Stripe Connect : POST et DELETE → 403, compte non modifié", async ({ browser }) => {
    const page = await demoAdmin(browser);
    const before = (await pool.query("SELECT stripe_account_id FROM tenants WHERE id = $1", [demoTenantId])).rows[0];
    expect((await page.request.post(`${DEMO}/api/admin/stripe/connect`)).status()).toBe(403);
    expect((await page.request.delete(`${DEMO}/api/admin/stripe/connect`)).status()).toBe(403);
    const after = (await pool.query("SELECT stripe_account_id FROM tenants WHERE id = $1", [demoTenantId])).rows[0];
    expect(after).toEqual(before);
    await page.context().close();
  });

  test("uploads : hero, galerie, photos de chambre (POST/PUT/DELETE) → 403", async ({ browser }) => {
    const page = await demoAdmin(browser);
    const file = { name: "x.png", mimeType: "image/png", buffer: PNG };
    const r = page.request;
    const statuses = await Promise.all([
      r.post(`${DEMO}/api/admin/hero-photo`, { multipart: { photo: file } }),
      r.delete(`${DEMO}/api/admin/hero-photo`),
      r.post(`${DEMO}/api/admin/gallery-photos`, { multipart: { photos: file } }),
      r.put(`${DEMO}/api/admin/gallery-photos`, { data: { order: [] } }),
      r.delete(`${DEMO}/api/admin/gallery-photos`, { data: { id: "x" } }),
      r.post(`${DEMO}/api/admin/rooms/${roomId}/photos`, { multipart: { photos: file } }),
      r.put(`${DEMO}/api/admin/rooms/${roomId}/photos`, { data: { order: [] } }),
      r.delete(`${DEMO}/api/admin/rooms/${roomId}/photos`, { data: { id: "x" } }),
    ]).then((res) => res.map((x) => x.status()));
    expect(statuses).toEqual(Array(8).fill(403));
    const { rows } = await pool.query("SELECT photos FROM rooms WHERE id = $1", [roomId]);
    expect(rows[0].photos).toEqual([]);
    await page.context().close();
  });

  test("réservation payée : confirmée, payment paid, aucun email (client ni admin)", async ({ request }) => {
    const sessionId = `cs_test_demo_${Date.now()}`;
    const dossierId = await insertDossier(pool, demoTenantId);
    const bookingId = (
      await pool.query(
        `INSERT INTO bookings (tenant_id, room_id, check_in, check_out, total_price, status, guest_name, guest_email, guest_count, source, dossier_id)
         VALUES ($1, $2, '2033-03-01', '2033-03-03', '200.00', 'pending', 'Client Démo', 'client-demo@example.com', 2, 'direct', $3)
         RETURNING id`,
        [demoTenantId, roomId, dossierId],
      )
    ).rows[0].id;
    await pool.query(
      `INSERT INTO payments (tenant_id, dossier_id, stripe_session_id, amount, currency, status)
       VALUES ($1, $2, $3, '200.00', 'eur', 'pending')`,
      [demoTenantId, dossierId, sessionId],
    );

    const sink = await startSmtpSink();
    try {
      const payload = JSON.stringify({
        id: `evt_test_demo_${Date.now()}`,
        type: "checkout.session.completed",
        livemode: false,
        data: { object: { id: sessionId, payment_intent: `pi_test_demo_${Date.now()}`, metadata: { dossierId, tenantId: demoTenantId } } },
      });
      const res = await request.post("/api/webhooks/stripe", {
        data: payload,
        headers: { "content-type": "application/json", "stripe-signature": stripeSignature(payload) },
      });
      expect(res.status()).toBe(200);

      const booking = await pool.query("SELECT status FROM bookings WHERE id = $1", [bookingId]);
      expect(booking.rows[0].status).toBe("confirmed");
      const payment = await pool.query("SELECT status FROM payments WHERE dossier_id = $1", [dossierId]);
      expect(payment.rows[0].status).toBe("paid");
      // Le webhook attend les envois avant de répondre : la boîte est déjà dans son état final.
      expect(sink.mails).toHaveLength(0);
    } finally {
      await sink.stop();
    }
  });

  test("mot de passe oublié : aucun lien envoyé au compte démo (contrôle : test-tenant reçoit le sien)", async ({ browser }) => {
    const page = await (await browser.newContext({ storageState: { cookies: [], origins: [] } })).newPage();
    const sink = await startSmtpSink();
    try {
      await page.goto(`${DEMO}/forgot-password`);
      await page.fill('[name="email"]', EMAIL);
      await page.click('[type="submit"]');
      await expect(page.getByText("recevrez un email")).toBeVisible({ timeout: 10000 });

      await page.goto("/forgot-password");
      await page.fill('[name="email"]', process.env.TEST_ADMIN_EMAIL!);
      await page.click('[type="submit"]');
      await expect(page.getByText("recevrez un email")).toBeVisible({ timeout: 10000 });
      await expect.poll(() => sink.mails.length, { timeout: 10000 }).toBeGreaterThan(0);
      expect(sink.mails.flatMap((m) => m.to)).toEqual([process.env.TEST_ADMIN_EMAIL]);
    } finally {
      await sink.stop();
      await page.context().close();
    }
  });

  test("slug et domaine : absents du formulaire, ignorés si injectés", async ({ browser }) => {
    const page = await demoAdmin(browser);
    const before = (await pool.query("SELECT slug, domain, name FROM tenants WHERE id = $1", [demoTenantId])).rows[0];
    await page.goto(`${DEMO}/admin/parametres`);
    await expect(page.locator('[name="slug"], [name="domain"]')).toHaveCount(0);
    await expect(page.getByText("demo-tenant", { exact: true })).toBeVisible();

    // Un visiteur malin ajoute les champs à la main : le serveur les ignore.
    const form = page.locator("form", { has: page.locator('[name="name"]') });
    await form.evaluate((f) => {
      for (const [n, v] of [["slug", "pirate"], ["domain", "pirate.example.com"]]) {
        const i = document.createElement("input");
        i.type = "hidden";
        i.name = n;
        i.value = v;
        f.appendChild(i);
      }
    });
    await form.getByRole("button", { name: /enregistrer/i }).first().click();
    await expect(page.getByText("Informations mises à jour.")).toBeVisible();

    const after = (await pool.query("SELECT slug, domain, name FROM tenants WHERE id = $1", [demoTenantId])).rows[0];
    expect(after).toEqual(before);
    await page.context().close();
  });
});

test.describe("Démo — l'UI explique", () => {
  test("Paiements et uploaders affichent « Désactivé en démo », sans bouton actif", async ({ browser }) => {
    const page = await demoAdmin(browser);
    await page.goto(`${DEMO}/admin/parametres?tab=calendriers`);
    await expect(page.getByText(/Désactivé en démo/)).toBeVisible();
    await expect(page.getByRole("button", { name: /Connecter Stripe/ })).toHaveCount(0);

    await page.goto(`${DEMO}/admin/parametres?tab=site`);
    await expect(page.getByText("Désactivé en démo", { exact: true })).toHaveCount(2);

    await page.goto(`${DEMO}/admin/chambres/${roomId}/edit`);
    await expect(page.getByText("Désactivé en démo", { exact: true })).toBeVisible();
    await page.context().close();
  });
});

// ─── Non-régression : test-tenant (session admin par défaut) garde tout ─────

test.describe("Tenant normal — rien n'est bloqué", () => {
  test("pas de bandeau démo, bouton Stripe présent, upload non refusé en 403", async ({ page }) => {
    await page.goto("/admin/parametres?tab=calendriers");
    await expect(page.getByRole("button", { name: /Connecter Stripe|Reprendre la configuration/ }).or(
      page.getByText("Ouvrir le Dashboard Stripe"),
    )).toBeVisible();
    await expect(page.getByText(/Désactivé en démo/)).toHaveCount(0);

    await page.goto("/admin/parametres?tab=site");
    await expect(page.getByText(/Désactivé en démo/)).toHaveCount(0);

    // Sans fichier : refus de validation (400), pas le garde démo.
    const res = await page.request.post("/api/admin/hero-photo", { multipart: { other: "x" } });
    expect(res.status()).toBe(400);
  });
});
