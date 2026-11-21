import fs from "fs";
import path from "path";
import crypto from "crypto";
import { Pool } from "pg";
import { test, expect } from "@playwright/test";
import { startSmtpSink } from "../helpers/smtp-sink";
import { mailBody, mailSubject } from "../helpers/mail-body";
import { insertDossier } from "../helpers/dossier";

/**
 * Spécification : Tests de non-régression > Paiement > Webhook Stripe
 * Référence Obsidian : Phase 5.1 — Stripe
 *
 * Ces tests envoient des requêtes HTTP directes au webhook Stripe
 * avec des signatures valides pour vérifier le traitement des événements.
 */

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? "whsec_test_XXXX";
const BASE_URL = "http://localhost:3001";

function loadTestContext() {
  const contextPath = path.join(process.cwd(), "e2e", ".auth", "test-context.json");
  return JSON.parse(fs.readFileSync(contextPath, "utf-8")) as {
    tenantId: string;
    apiRoomId: string;
    rivalTenantId: string;
    rivalRoomId: string;
  };
}

/**
 * Génère un header de signature Stripe valide pour un payload donné.
 * Reproduit le comportement de Stripe.webhooks.generateTestHeaderString.
 */
function generateStripeSignature(payload: string, secret: string): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const signedPayload = `${timestamp}.${payload}`;
  const signature = crypto
    .createHmac("sha256", secret)
    .update(signedPayload)
    .digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

/**
 * Crée un Dossier d'une chambre (booking pending) + son payment et retourne l'id du booking.
 * Les tests historiques envoient `metadata.bookingId` : sessions créées avant les Dossiers,
 * toujours reconnues. Les sessions actuelles portent `metadata.dossierId` (cf. tests Dossier).
 */
async function createTestBookingWithPayment(
  pool: Pool,
  tenantId: string,
  roomId: string,
  stripeSessionId: string,
) {
  const dossierId = await insertDossier(pool, tenantId, { checkIn: "2026-09-01", checkOut: "2026-09-05" });
  const bookingResult = await pool.query(
    `INSERT INTO bookings (tenant_id, dossier_id, room_id, check_in, check_out, total_price, status, guest_name, guest_email, guest_count, source)
     VALUES ($1, $3, $2, '2026-09-01', '2026-09-05', '400.00', 'pending', 'Test Webhook', 'webhook@test.com', 2, 'direct')
     RETURNING id`,
    [tenantId, roomId, dossierId],
  );
  const bookingId = bookingResult.rows[0].id;

  await pool.query(
    `INSERT INTO payments (tenant_id, dossier_id, stripe_session_id, amount, currency, status)
     VALUES ($1, $2, $3, '400.00', 'eur', 'pending')`,
    [tenantId, dossierId, stripeSessionId],
  );

  return bookingId;
}

/** Supprime le Dossier d'un booking : payments, bookings, puis le Dossier. */
async function deleteDossierOf(pool: Pool, bookingId: string) {
  const { rows } = await pool.query("SELECT dossier_id FROM bookings WHERE id = $1", [bookingId]);
  if (rows.length === 0) return;
  await deleteDossier(pool, rows[0].dossier_id);
}

async function deleteDossier(pool: Pool, dossierId: string) {
  await pool.query("DELETE FROM payments WHERE dossier_id = $1", [dossierId]);
  await pool.query("DELETE FROM bookings WHERE dossier_id = $1", [dossierId]);
  await pool.query("DELETE FROM dossiers WHERE id = $1", [dossierId]);
}

test.describe("Paiement — Webhook Stripe", () => {
  let pool: Pool;

  test.beforeAll(() => {
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  });

  test.afterAll(async () => {
    await pool.end();
  });

  // ─── Happy path ────────────────────────────────────────────────────────────

  test("checkout.session.completed passe le booking en confirmed et le payment en paid", async ({
    request,
  }) => {
    const { tenantId, apiRoomId } = loadTestContext();
    const sessionId = `cs_test_completed_${Date.now()}`;

    const bookingId = await createTestBookingWithPayment(
      pool,
      tenantId,
      apiRoomId,
      sessionId,
    );

    try {
      const eventPayload = JSON.stringify({
        id: `evt_test_${Date.now()}`,
        type: "checkout.session.completed",
        data: {
          object: {
            id: sessionId,
            payment_intent: `pi_test_${Date.now()}`,
            metadata: { bookingId, tenantId },
          },
        },
      });

      const signature = generateStripeSignature(eventPayload, WEBHOOK_SECRET);

      const response = await request.post(`${BASE_URL}/api/webhooks/stripe`, {
        data: eventPayload,
        headers: {
          "content-type": "application/json",
          "stripe-signature": signature,
        },
      });

      expect(response.status()).toBe(200);

      // Vérifier que le booking est passé en confirmed
      const bookingResult = await pool.query(
        "SELECT status FROM bookings WHERE id = $1",
        [bookingId],
      );
      expect(bookingResult.rows[0].status).toBe("confirmed");

      // Vérifier que le payment est passé en paid
      const paymentResult = await pool.query(
        "SELECT status, stripe_payment_id FROM payments WHERE stripe_session_id = $1",
        [sessionId],
      );
      expect(paymentResult.rows[0].status).toBe("paid");
      expect(paymentResult.rows[0].stripe_payment_id).toBeTruthy();
    } finally {
      // Nettoyage
      await deleteDossierOf(pool, bookingId);
    }
  });

  test("checkout.session.expired passe le booking en cancelled et le payment en expired", async ({
    request,
  }) => {
    const { tenantId, apiRoomId } = loadTestContext();
    const sessionId = `cs_test_expired_${Date.now()}`;

    const bookingId = await createTestBookingWithPayment(
      pool,
      tenantId,
      apiRoomId,
      sessionId,
    );

    try {
      const eventPayload = JSON.stringify({
        id: `evt_test_${Date.now()}`,
        type: "checkout.session.expired",
        data: {
          object: {
            id: sessionId,
            metadata: { bookingId, tenantId },
          },
        },
      });

      const signature = generateStripeSignature(eventPayload, WEBHOOK_SECRET);

      const response = await request.post(`${BASE_URL}/api/webhooks/stripe`, {
        data: eventPayload,
        headers: {
          "content-type": "application/json",
          "stripe-signature": signature,
        },
      });

      expect(response.status()).toBe(200);

      // Vérifier que le booking est passé en cancelled
      const bookingResult = await pool.query(
        "SELECT status FROM bookings WHERE id = $1",
        [bookingId],
      );
      expect(bookingResult.rows[0].status).toBe("cancelled");

      // Vérifier que le payment est passé en expired
      const paymentResult = await pool.query(
        "SELECT status FROM payments WHERE stripe_session_id = $1",
        [sessionId],
      );
      expect(paymentResult.rows[0].status).toBe("expired");
    } finally {
      await deleteDossierOf(pool, bookingId);
    }
  });

  // ─── Idempotence & transitions ───────────────────────────────────────────

  test("checkout.session.completed dupliqué est idempotent (pas de re-transition ni d'email en double)", async ({
    request,
  }) => {
    const { tenantId, apiRoomId } = loadTestContext();
    const sessionId = `cs_test_dup_${Date.now()}`;
    const bookingId = await createTestBookingWithPayment(
      pool,
      tenantId,
      apiRoomId,
      sessionId,
    );

    const send = () => {
      const payload = JSON.stringify({
        id: `evt_test_${Date.now()}_${Math.random()}`,
        type: "checkout.session.completed",
        data: {
          object: {
            id: sessionId,
            payment_intent: `pi_test_${Date.now()}`,
            metadata: { bookingId, tenantId },
          },
        },
      });
      return request.post(`${BASE_URL}/api/webhooks/stripe`, {
        data: payload,
        headers: {
          "content-type": "application/json",
          "stripe-signature": generateStripeSignature(payload, WEBHOOK_SECRET),
        },
      });
    };

    try {
      const first = await send();
      expect(first.status()).toBe(200);

      const afterFirst = await pool.query(
        "SELECT status, updated_at FROM bookings WHERE id = $1",
        [bookingId],
      );
      expect(afterFirst.rows[0].status).toBe("confirmed");
      const firstUpdatedAt = new Date(afterFirst.rows[0].updated_at).getTime();

      // Stripe réessaie : seconde livraison du même événement.
      const second = await send();
      expect(second.status()).toBe(200);

      const afterSecond = await pool.query(
        "SELECT status, updated_at FROM bookings WHERE id = $1",
        [bookingId],
      );
      expect(afterSecond.rows[0].status).toBe("confirmed");
      // updated_at inchangé ⇒ aucune ligne re-transitionnée ⇒ aucun email en double.
      expect(new Date(afterSecond.rows[0].updated_at).getTime()).toBe(
        firstUpdatedAt,
      );
    } finally {
      await deleteDossierOf(pool, bookingId);
    }
  });

  test("checkout.session.completed ne ressuscite pas un booking annulé (transition illégale refusée)", async ({
    request,
  }) => {
    const { tenantId, apiRoomId } = loadTestContext();
    const sessionId = `cs_test_resurrect_${Date.now()}`;
    const bookingId = await createTestBookingWithPayment(
      pool,
      tenantId,
      apiRoomId,
      sessionId,
    );
    // Le booking a été annulé entre-temps (expiration ou annulation admin).
    await pool.query("UPDATE bookings SET status = 'cancelled' WHERE id = $1", [
      bookingId,
    ]);

    try {
      const payload = JSON.stringify({
        id: `evt_test_${Date.now()}`,
        type: "checkout.session.completed",
        data: {
          object: {
            id: sessionId,
            payment_intent: `pi_test_${Date.now()}`,
            metadata: { bookingId, tenantId },
          },
        },
      });
      const response = await request.post(`${BASE_URL}/api/webhooks/stripe`, {
        data: payload,
        headers: {
          "content-type": "application/json",
          "stripe-signature": generateStripeSignature(payload, WEBHOOK_SECRET),
        },
      });
      expect(response.status()).toBe(200);

      const result = await pool.query(
        "SELECT status FROM bookings WHERE id = $1",
        [bookingId],
      );
      // cancelled → confirmed est illégale : le booking reste cancelled.
      expect(result.rows[0].status).toBe("cancelled");
    } finally {
      await deleteDossierOf(pool, bookingId);
    }
  });

  test("paiement reçu sur un booking annulé : payment paid, booking reste annulé, admins alertés une seule fois", async ({
    request,
  }) => {
    const { tenantId, apiRoomId } = loadTestContext();
    const sessionId = `cs_test_paidcancelled_${Date.now()}`;
    const paymentIntent = `pi_test_paidcancelled_${Date.now()}`;
    const bookingId = await createTestBookingWithPayment(pool, tenantId, apiRoomId, sessionId);
    // L'admin annule pendant que le client est sur Stripe Checkout.
    await pool.query("UPDATE bookings SET status = 'cancelled' WHERE id = $1", [bookingId]);
    const admins = (
      await pool.query(
        "SELECT u.email FROM user_tenants ut JOIN users u ON u.id = ut.user_id WHERE ut.tenant_id = $1",
        [tenantId],
      )
    ).rows.map((r) => r.email as string);
    expect(admins.length).toBeGreaterThan(0);

    const sink = await startSmtpSink();
    const send = () => {
      const payload = JSON.stringify({
        id: `evt_test_${Date.now()}_${Math.random()}`,
        type: "checkout.session.completed",
        data: { object: { id: sessionId, payment_intent: paymentIntent, metadata: { bookingId, tenantId } } },
      });
      return request.post(`${BASE_URL}/api/webhooks/stripe`, {
        data: payload,
        headers: {
          "content-type": "application/json",
          "stripe-signature": generateStripeSignature(payload, WEBHOOK_SECRET),
        },
      });
    };

    try {
      expect((await send()).status()).toBe(200);

      const booking = await pool.query("SELECT status FROM bookings WHERE id = $1", [bookingId]);
      expect(booking.rows[0].status).toBe("cancelled");
      const payment = await pool.query(
        "SELECT status, stripe_payment_id FROM payments WHERE stripe_session_id = $1",
        [sessionId],
      );
      expect(payment.rows[0]).toEqual({ status: "paid", stripe_payment_id: paymentIntent });

      // Une alerte par admin, et rien pour le client (pas de confirmation).
      expect(sink.mails.flatMap((m) => m.to).sort()).toEqual([...admins].sort());
      expect(sink.mails[0].raw).toContain("remboursez"); // sujet « … — remboursez via Stripe »

      // Re-livraison Stripe du même événement : aucune alerte en double.
      expect((await send()).status()).toBe(200);
      expect(sink.mails).toHaveLength(admins.length);
    } finally {
      await sink.stop();
      await deleteDossierOf(pool, bookingId);
    }
  });

  // ─── Stripe Connect en direct charge (audit 2026-10b/01) ────────────────────
  // La session vit sur le compte du tenant : l'événement arrive par l'endpoint Connect,
  // signé avec STRIPE_CONNECT_WEBHOOK_SECRET et porteur de `account`.

  const CONNECT_SECRET = process.env.STRIPE_CONNECT_WEBHOOK_SECRET!;

  async function postConnectEvent(
    request: import("@playwright/test").APIRequestContext,
    account: string,
    sessionId: string,
    metadata: Record<string, string>,
  ) {
    const payload = JSON.stringify({
      id: `evt_connect_${Date.now()}`,
      type: "checkout.session.completed",
      account,
      data: { object: { id: sessionId, payment_intent: `pi_connect_${Date.now()}`, metadata } },
    });
    return request.post(`${BASE_URL}/api/webhooks/stripe`, {
      data: payload,
      headers: {
        "content-type": "application/json",
        "stripe-signature": generateStripeSignature(payload, CONNECT_SECRET),
      },
    });
  }

  test("événement Connect du compte du tenant (secret Connect) → booking confirmed", async ({ request }) => {
    const { tenantId, apiRoomId } = loadTestContext();
    const sessionId = `cs_test_connect_${Date.now()}`;
    const account = `acct_test_${Date.now()}`;
    const { rows } = await pool.query("SELECT stripe_account_id FROM tenants WHERE id = $1", [tenantId]);
    await pool.query("UPDATE tenants SET stripe_account_id = $2 WHERE id = $1", [tenantId, account]);
    const bookingId = await createTestBookingWithPayment(pool, tenantId, apiRoomId, sessionId);
    try {
      const res = await postConnectEvent(request, account, sessionId, { bookingId, tenantId });
      expect(res.status()).toBe(200);
      const b = await pool.query("SELECT status FROM bookings WHERE id = $1", [bookingId]);
      expect(b.rows[0].status).toBe("confirmed");
    } finally {
      await pool.query("UPDATE tenants SET stripe_account_id = $2 WHERE id = $1", [tenantId, rows[0].stripe_account_id]);
      await deleteDossierOf(pool, bookingId);
    }
  });

  test("événement Connect d'un autre compte (sa propre session, metadata d'un autre hôtel) → 200 mais booking intact", async ({ request }) => {
    const { tenantId, apiRoomId } = loadTestContext();
    const sessionId = `cs_test_connect_victim_${Date.now()}`;
    const bookingId = await createTestBookingWithPayment(pool, tenantId, apiRoomId, sessionId);
    try {
      // Le compte intrus ne peut émettre que ses propres sessions (id choisi par Stripe) :
      // il ne connaît pas `sessionId`, seulement le bookingId/tenantId de la victime.
      const foreignSession = `cs_test_connect_intrus_${Date.now()}`;
      expect((await postConnectEvent(request, "acct_intrus", foreignSession, { bookingId, tenantId })).status()).toBe(200);
      // metadata malformée : ignorée, jamais 500.
      expect((await postConnectEvent(request, "acct_intrus", foreignSession, { bookingId, tenantId: "pas-un-uuid" })).status()).toBe(200);
      expect((await postConnectEvent(request, "acct_intrus", foreignSession, { bookingId: "pas-un-uuid", tenantId })).status()).toBe(200);
      // Bonne session mais metadata pointant vers un autre booking : ignoré aussi.
      const other = await createTestBookingWithPayment(pool, tenantId, apiRoomId, `${sessionId}_autre`);
      expect((await postConnectEvent(request, "acct_intrus", sessionId, { bookingId: other, tenantId })).status()).toBe(200);
      const o = await pool.query("SELECT status FROM bookings WHERE id = $1", [other]);
      expect(o.rows[0].status).toBe("pending");
      await deleteDossierOf(pool, other);

      const b = await pool.query("SELECT status FROM bookings WHERE id = $1", [bookingId]);
      expect(b.rows[0].status).toBe("pending");
    } finally {
      await deleteDossierOf(pool, bookingId);
    }
  });

  test("paiement abouti après déconnexion Stripe du tenant → booking confirmed quand même (audit 2026-10c/2)", async ({ request }) => {
    const { tenantId, apiRoomId } = loadTestContext();
    const sessionId = `cs_test_connect_disconnected_${Date.now()}`;
    const { rows } = await pool.query("SELECT stripe_account_id FROM tenants WHERE id = $1", [tenantId]);
    const bookingId = await createTestBookingWithPayment(pool, tenantId, apiRoomId, sessionId);
    try {
      // Session créée sur l'ancien compte, puis l'hôte a cliqué « Déconnecter ».
      await pool.query("UPDATE tenants SET stripe_account_id = NULL WHERE id = $1", [tenantId]);
      expect((await postConnectEvent(request, "acct_ancien", sessionId, { bookingId, tenantId })).status()).toBe(200);
      const b = await pool.query("SELECT status FROM bookings WHERE id = $1", [bookingId]);
      expect(b.rows[0].status).toBe("confirmed");
    } finally {
      await pool.query("UPDATE tenants SET stripe_account_id = $2 WHERE id = $1", [tenantId, rows[0].stripe_account_id]);
      await deleteDossierOf(pool, bookingId);
    }
  });

  // ─── Cas d'erreur ──────────────────────────────────────────────────────────

  test("signature Stripe invalide retourne 400", async ({ request }) => {
    const response = await request.post(`${BASE_URL}/api/webhooks/stripe`, {
      data: JSON.stringify({ type: "test" }),
      headers: {
        "content-type": "application/json",
        "stripe-signature": "t=123,v1=invalide",
      },
    });

    expect(response.status()).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("Signature invalide");
  });

  test("rafale de 65 webhooks à signature invalide : tous 400, aucun 429 (audit 2026-10b/10)", async ({ request }) => {
    // 65 > 30 (ancienne limite webhook) et > 60 (limite API publique) : aucune ne doit s'appliquer.
    const headers = {
      "content-type": "application/json",
      "stripe-signature": "t=123,v1=invalide",
      "x-forwarded-for": "10.10.9.7",
    };
    const statuses: number[] = [];
    for (let i = 0; i < 65; i++) {
      const res = await request.post(`${BASE_URL}/api/webhooks/stripe`, { data: "{}", headers });
      statuses.push(res.status());
    }
    expect(statuses.filter((s) => s !== 400)).toEqual([]);
  });

  test("signature Stripe absente retourne 400", async ({ request }) => {
    const response = await request.post(`${BASE_URL}/api/webhooks/stripe`, {
      data: JSON.stringify({ type: "test" }),
      headers: {
        "content-type": "application/json",
      },
    });

    expect(response.status()).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("Signature manquante");
  });

  test("événement avec bookingId inexistant ne plante pas (200)", async ({ request }) => {
    const eventPayload = JSON.stringify({
      id: `evt_test_${Date.now()}`,
      type: "checkout.session.completed",
      data: {
        object: {
          id: `cs_test_unknown_${Date.now()}`,
          payment_intent: "pi_test_unknown",
          metadata: {
            bookingId: "00000000-0000-0000-0000-000000000000",
            tenantId: "00000000-0000-0000-0000-000000000000",
          },
        },
      },
    });

    const signature = generateStripeSignature(eventPayload, WEBHOOK_SECRET);

    const response = await request.post(`${BASE_URL}/api/webhooks/stripe`, {
      data: eventPayload,
      headers: {
        "content-type": "application/json",
        "stripe-signature": signature,
      },
    });

    // Le webhook doit toujours répondre 200 (Stripe réessaie sinon)
    expect(response.status()).toBe(200);
  });
});

/**
 * Dossier (ADR-0012) : une session Stripe paie toutes les chambres du Dossier.
 * Les sessions actuelles portent `metadata.dossierId`.
 */
test.describe("Paiement — Webhook Stripe sur un Dossier de plusieurs chambres", () => {
  let pool: Pool;
  let firstRoomId: string;
  let secondRoomId: string;
  const CHECK_IN = "2034-02-06";
  const CHECK_OUT = "2034-02-09";

  test.beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const { tenantId, apiRoomId } = loadTestContext();
    // Deux chambres dédiées : apiRoom est partagée (règles, holds) par d'autres specs en parallèle.
    const insertRoom = async (n: number) =>
      (
        await pool.query(
          `INSERT INTO rooms (tenant_id, property_id, name, slug, price_per_night, capacity)
           SELECT tenant_id, property_id, $3, $2, '90.00', 2 FROM rooms WHERE id = $1
           RETURNING id`,
          [apiRoomId, `chambre-dossier-test-${n}-${Date.now()}`, `Chambre Dossier Test ${n}`],
        )
      ).rows[0].id as string;
    firstRoomId = await insertRoom(1);
    secondRoomId = await insertRoom(2);
    expect(tenantId).toBeTruthy();
  });

  test.afterAll(async () => {
    await pool.query("DELETE FROM rooms WHERE id = ANY($1::uuid[])", [[firstRoomId, secondRoomId]]);
    await pool.end();
  });

  /** Dossier de 2 chambres (pending) + son payment ; ids du Dossier et de ses réservations. */
  async function createTwoRoomDossier(tenantId: string, roomIds: string[], sessionId: string) {
    const dossierId = await insertDossier(pool, tenantId, { checkIn: CHECK_IN, checkOut: CHECK_OUT, guestName: "Famille Dossier" });
    const bookingIds: string[] = [];
    for (const roomId of roomIds) {
      const { rows } = await pool.query(
        `INSERT INTO bookings (tenant_id, dossier_id, room_id, check_in, check_out, total_price, status, guest_name, guest_email, guest_count, source)
         VALUES ($1, $2, $3, $4, $5, '270.00', 'pending', 'Famille Dossier', 'dossier@example.com', 2, 'direct') RETURNING id`,
        [tenantId, dossierId, roomId, CHECK_IN, CHECK_OUT],
      );
      bookingIds.push(rows[0].id);
    }
    await pool.query(
      `INSERT INTO payments (tenant_id, dossier_id, stripe_session_id, amount, currency, status)
       VALUES ($1, $2, $3, '540.00', 'eur', 'pending')`,
      [tenantId, dossierId, sessionId],
    );
    return { dossierId, bookingIds };
  }

  function post(
    request: import("@playwright/test").APIRequestContext,
    type: "checkout.session.completed" | "checkout.session.expired",
    sessionId: string,
    metadata: Record<string, string>,
  ) {
    const payload = JSON.stringify({
      id: `evt_dossier_${Date.now()}_${Math.random()}`,
      type,
      data: { object: { id: sessionId, payment_intent: `pi_dossier_${sessionId}`, metadata } },
    });
    return request.post(`${BASE_URL}/api/webhooks/stripe`, {
      data: payload,
      headers: {
        "content-type": "application/json",
        "stripe-signature": generateStripeSignature(payload, WEBHOOK_SECRET),
      },
    });
  }

  const statuses = async (ids: string[]) =>
    (await pool.query("SELECT status FROM bookings WHERE id = ANY($1::uuid[]) ORDER BY status", [ids])).rows.map(
      (r) => r.status as string,
    );
  const paymentStatus = async (sessionId: string) =>
    (await pool.query("SELECT status FROM payments WHERE stripe_session_id = $1", [sessionId])).rows[0]?.status;

  test("completed → les 2 réservations confirmed, payment paid ; re-livraison sans effet", async ({ request }) => {
    const { tenantId } = loadTestContext();
    const sessionId = `cs_test_dossier_ok_${Date.now()}`;
    const { dossierId, bookingIds } = await createTwoRoomDossier(tenantId, [firstRoomId, secondRoomId], sessionId);
    try {
      expect((await post(request, "checkout.session.completed", sessionId, { dossierId, tenantId })).status()).toBe(200);
      expect(await statuses(bookingIds)).toEqual(["confirmed", "confirmed"]);
      expect(await paymentStatus(sessionId)).toBe("paid");

      const before = (await pool.query("SELECT max(updated_at) AS t FROM bookings WHERE dossier_id = $1", [dossierId])).rows[0].t;
      expect((await post(request, "checkout.session.completed", sessionId, { dossierId, tenantId })).status()).toBe(200);
      // Un expired tardif n'annule pas un Dossier payé.
      expect((await post(request, "checkout.session.expired", sessionId, { dossierId, tenantId })).status()).toBe(200);
      expect(await statuses(bookingIds)).toEqual(["confirmed", "confirmed"]);
      const after = (await pool.query("SELECT max(updated_at) AS t FROM bookings WHERE dossier_id = $1", [dossierId])).rows[0].t;
      expect(new Date(after).getTime()).toBe(new Date(before).getTime());
    } finally {
      await deleteDossier(pool, dossierId);
    }
  });

  test("expired → les 2 réservations cancelled, payment expired, chambres de nouveau libres", async ({ request }) => {
    const { tenantId } = loadTestContext();
    const sessionId = `cs_test_dossier_exp_${Date.now()}`;
    const { dossierId, bookingIds } = await createTwoRoomDossier(tenantId, [firstRoomId, secondRoomId], sessionId);
    const blocked = async (roomId: string) => {
      const res = await request.get(`${BASE_URL}/api/availability?roomId=${roomId}&from=${CHECK_IN}&to=${CHECK_OUT}`);
      expect(res.status()).toBe(200);
      return ((await res.json()) as { blockedDates: string[] }).blockedDates;
    };
    try {
      // Le Dossier pending retient les deux chambres.
      expect(await blocked(firstRoomId)).toContain(CHECK_IN);
      expect(await blocked(secondRoomId)).toContain(CHECK_IN);

      expect((await post(request, "checkout.session.expired", sessionId, { dossierId, tenantId })).status()).toBe(200);
      expect(await statuses(bookingIds)).toEqual(["cancelled", "cancelled"]);
      expect(await paymentStatus(sessionId)).toBe("expired");
      expect(await blocked(firstRoomId)).toEqual([]);
      expect(await blocked(secondRoomId)).toEqual([]);

      // Paiement tardif sur un Dossier expiré : rien n'est ressuscité.
      expect((await post(request, "checkout.session.completed", sessionId, { dossierId, tenantId })).status()).toBe(200);
      expect(await statuses(bookingIds)).toEqual(["cancelled", "cancelled"]);
    } finally {
      await deleteDossier(pool, dossierId);
    }
  });

  test("une chambre annulée avant le paiement reste annulée, l'autre est confirmée ; admins alertés « remboursement partiel » une fois", async ({ request }) => {
    const { tenantId } = loadTestContext();
    const sessionId = `cs_test_dossier_partial_${Date.now()}`;
    const { dossierId, bookingIds } = await createTwoRoomDossier(tenantId, [firstRoomId, secondRoomId], sessionId);
    const admins = (
      await pool.query(
        "SELECT u.email FROM user_tenants ut JOIN users u ON u.id = ut.user_id WHERE ut.tenant_id = $1",
        [tenantId],
      )
    ).rows.map((r) => r.email as string);
    const sink = await startSmtpSink();
    try {
      await pool.query("UPDATE bookings SET status = 'cancelled' WHERE id = $1", [bookingIds[1]]);
      expect((await post(request, "checkout.session.completed", sessionId, { dossierId, tenantId })).status()).toBe(200);
      const rows = (await pool.query("SELECT id, status FROM bookings WHERE dossier_id = $1", [dossierId])).rows;
      expect(Object.fromEntries(rows.map((r) => [r.id, r.status]))).toEqual({
        [bookingIds[0]]: "confirmed",
        [bookingIds[1]]: "cancelled",
      });
      expect(await paymentStatus(sessionId)).toBe("paid");

      // Alerte « remboursement partiel » : une par admin, nommant la chambre annulée.
      const alerts = () => sink.mails.filter((m) => mailSubject(m).includes("remboursement partiel"));
      await expect.poll(() => alerts().length).toBe(admins.length);
      expect(alerts().flatMap((m) => m.to).sort()).toEqual([...admins].sort());
      expect(mailBody(alerts()[0])).toContain("<strong>Chambre Dossier Test 2</strong> (270.00 &euro;)");

      // Re-livraison : plus rien à confirmer, pas d'alerte en double.
      expect((await post(request, "checkout.session.completed", sessionId, { dossierId, tenantId })).status()).toBe(200);
      expect(alerts()).toHaveLength(admins.length);
    } finally {
      await sink.stop();
      await deleteDossier(pool, dossierId);
    }
  });

  test("isolation : metadata désignant un autre Dossier ou un autre tenant → ignoré, rien ne bouge", async ({ request }) => {
    const ctx = loadTestContext();
    const { tenantId } = ctx;
    const stamp = Date.now();
    const ours = await createTwoRoomDossier(tenantId, [firstRoomId, secondRoomId], `cs_test_dossier_ours_${stamp}`);
    const rival = await createTwoRoomDossier(ctx.rivalTenantId, [ctx.rivalRoomId], `cs_test_dossier_rival_${stamp}`);
    try {
      // Notre session, mais metadata pointant le Dossier du rival (avec notre tenant ou le sien).
      const attempts: Record<string, string>[] = [
        { dossierId: rival.dossierId, tenantId },
        { dossierId: rival.dossierId, tenantId: ctx.rivalTenantId },
        { dossierId: ours.dossierId, tenantId: ctx.rivalTenantId },
        { dossierId: "pas-un-uuid", tenantId },
        { dossierId: ours.dossierId, tenantId: "pas-un-uuid" },
        { tenantId },
      ];
      for (const metadata of attempts) {
        expect((await post(request, "checkout.session.completed", `cs_test_dossier_ours_${stamp}`, metadata)).status()).toBe(200);
      }
      // Session du rival, metadata d'un de nos Dossiers : ignoré aussi.
      expect(
        (await post(request, "checkout.session.expired", `cs_test_dossier_rival_${stamp}`, { dossierId: ours.dossierId, tenantId })).status(),
      ).toBe(200);
      // Session inconnue avec un vrai Dossier.
      expect(
        (await post(request, "checkout.session.completed", `cs_test_dossier_inconnue_${stamp}`, { dossierId: ours.dossierId, tenantId })).status(),
      ).toBe(200);

      expect(await statuses(ours.bookingIds)).toEqual(["pending", "pending"]);
      expect(await statuses(rival.bookingIds)).toEqual(["pending"]);
      expect(await paymentStatus(`cs_test_dossier_ours_${stamp}`)).toBe("pending");
      expect(await paymentStatus(`cs_test_dossier_rival_${stamp}`)).toBe("pending");
    } finally {
      await deleteDossier(pool, ours.dossierId);
      await deleteDossier(pool, rival.dossierId);
    }
  });
});
