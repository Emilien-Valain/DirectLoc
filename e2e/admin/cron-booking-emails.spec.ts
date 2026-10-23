import { test, expect } from "@playwright/test";
import fs from "fs";
import path from "path";
import { Pool } from "pg";

/**
 * Spécification : Tests de non-régression > Cron > Emails automatiques
 * Référence Obsidian : Phase 9.5/9.6 — Rappel J-2 et remerciement post-séjour
 *
 * Stratégie : tester la protection par CRON_SECRET de l'endpoint.
 * Les tests d'envoi réel d'email sont hors scope (pas de SMTP en test).
 */

test.describe("Cron — Booking emails", () => {
  test("endpoint sans Authorization → 401 ou 500 (si CRON_SECRET non configuré)", async ({ request }) => {
    const res = await request.get("/api/cron/booking-emails");
    // 401 si CRON_SECRET configuré, 500 si non configuré
    expect([401, 500]).toContain(res.status());
  });

  test("endpoint avec mauvais secret → 401 ou 500", async ({ request }) => {
    const res = await request.get("/api/cron/booking-emails", {
      headers: { Authorization: "Bearer mauvais-secret" },
    });
    expect([401, 500]).toContain(res.status());
    // Dans tous les cas, pas de 200
    expect(res.status()).not.toBe(200);
  });

  test("endpoint avec bon secret → 200 et JSON valide", async ({ request }) => {
    const secret = process.env.CRON_SECRET;
    test.skip(!secret, "CRON_SECRET non configuré dans l'environnement de test");

    const res = await request.get("/api/cron/booking-emails", {
      headers: { Authorization: `Bearer ${secret}` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("reminders");
    expect(body).toHaveProperty("thankYous");
    expect(body).toHaveProperty("errors");
  });
});

// ─── Filet de sécurité : pending orphelins (audit 2026-10b/08) ───────────────

test.describe("Cron — cancelOrphanPending n'annule que les vrais orphelins", () => {
  const ctx = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "e2e", ".auth", "test-context.json"), "utf-8"),
  ) as { tenantId: string; apiRoomId: string };
  const tag = `orphan-${Date.now()}`;

  test("A (direct, 2h, sans paiement) annulé ; B (avec paiement), C (10 min), D (manuel) restent pending, E (confirmé) intact", async ({ request }) => {
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const insert = async (label: string, checkIn: string, source: string, age: string, status = "pending") => {
      const { rows } = await pool.query(
        `INSERT INTO bookings (tenant_id, room_id, check_in, check_out, total_price, status, guest_name, guest_email, guest_count, source, created_at)
         VALUES ($1, $2, $3::date, $3::date + 2, '200.00', $8, $4, $5, 1, $6, now() - $7::interval) RETURNING id`,
        [ctx.tenantId, ctx.apiRoomId, checkIn, label, `${tag}-${label}@example.com`, source, age, status],
      );
      return rows[0].id as string;
    };
    try {
      const a = await insert("A", "2032-01-05", "direct", "2 hours");
      const b = await insert("B", "2032-01-10", "direct", "2 hours");
      const c = await insert("C", "2032-01-15", "direct", "10 minutes");
      const d = await insert("D", "2032-01-20", "manual", "2 hours");
      const e = await insert("E", "2032-01-25", "direct", "2 hours", "confirmed");
      await pool.query(
        "INSERT INTO payments (tenant_id, booking_id, amount, status) VALUES ($1, $2, '200.00', 'pending')",
        [ctx.tenantId, b],
      );

      const res = await request.get("/api/cron/booking-emails", {
        headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
      });
      expect(res.status()).toBe(200);

      const { rows } = await pool.query("SELECT id, status FROM bookings WHERE guest_email LIKE $1", [`${tag}-%`]);
      const status = Object.fromEntries(rows.map((r) => [r.id, r.status]));
      expect(status).toEqual({ [a]: "cancelled", [b]: "pending", [c]: "pending", [d]: "pending", [e]: "confirmed" });
    } finally {
      await pool.query("DELETE FROM payments WHERE booking_id IN (SELECT id FROM bookings WHERE guest_email LIKE $1)", [`${tag}-%`]);
      await pool.query("DELETE FROM bookings WHERE guest_email LIKE $1", [`${tag}-%`]);
      await pool.end();
    }
  });
});
