import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { deleteOrphanDossiers } from "../helpers/dossier";

/**
 * Isolation multi-tenant des actions de la fiche Dossier (ADR-0002, ADR-0012) : annuler une
 * chambre, annuler le Dossier, marquer réglé / pas réglé, changer les dates, ajouter une chambre.
 *
 * Les arguments liés des server actions sont chiffrés par Next : impossible de les forger
 * depuis un navigateur. On teste donc la logique qu'elles appellent après la session
 * (`lib/dossier-admin.ts`, tenant explicite) via une sonde tsx sur la base de test,
 * comme `admission-pool.spec.ts`. Preuve : aucune ligne du tenant B ne bouge, alors que
 * les mêmes appels agissent bien sur un Dossier du tenant A.
 */

const ctx = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "e2e", ".auth", "test-context.json"), "utf-8"),
) as { tenantId: string; apiRoomId: string; rivalTenantId: string; rivalRoomId: string };

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const STAMP = Date.now().toString(36);
const EMAIL = `dossier-isolation-${STAMP}@example.com`;
const ownRooms: string[] = [];

/** Tout ce qui décrit le Dossier B en base : Dossier, réservations, lignes, paiements. */
async function snapshot(dossierId: string) {
  const q = async (sql: string) => (await pool.query(sql, [dossierId])).rows;
  return {
    dossier: await q("SELECT * FROM dossiers WHERE id = $1"),
    bookings: await q("SELECT * FROM bookings WHERE dossier_id = $1 ORDER BY id"),
    lines: await q("SELECT l.* FROM booking_lines l JOIN bookings b ON b.id = l.booking_id WHERE b.dossier_id = $1 ORDER BY l.id"),
    payments: await q("SELECT * FROM payments WHERE dossier_id = $1 ORDER BY id"),
  };
}

async function insertDossier(tenantId: string, roomId: string, name: string) {
  const { rows } = await pool.query(
    `INSERT INTO dossiers (tenant_id, check_in, check_out, guest_name, guest_email)
     VALUES ($1, '2036-02-10', '2036-02-12', $2, $3) RETURNING id`,
    [tenantId, name, EMAIL],
  );
  const dossierId = rows[0].id as string;
  const b = await pool.query(
    `INSERT INTO bookings (tenant_id, dossier_id, room_id, check_in, check_out, total_price, status, guest_name, guest_email, guest_count, source)
     VALUES ($1, $2, $3, '2036-02-10', '2036-02-12', '200.00', 'confirmed', $4, $5, 1, 'manual') RETURNING id`,
    [tenantId, dossierId, roomId, name, EMAIL],
  );
  const bookingId = b.rows[0].id as string;
  await pool.query(
    `INSERT INTO booking_lines (booking_id, kind, label, unit, unit_price, quantity, total)
     VALUES ($1, 'extra', 'Petit-déjeuner', 'per_stay', '10.00', 1, '10.00')`,
    [bookingId],
  );
  return { dossierId, bookingId };
}

test.afterAll(async () => {
  const { rows } = await pool.query("SELECT id FROM dossiers WHERE guest_email = $1", [EMAIL]);
  const ids = rows.map((r) => r.id as string);
  await pool.query("DELETE FROM booking_lines WHERE booking_id IN (SELECT id FROM bookings WHERE dossier_id = ANY($1::uuid[]))", [ids]);
  await pool.query("DELETE FROM payments WHERE dossier_id = ANY($1::uuid[])", [ids]);
  await pool.query("DELETE FROM bookings WHERE dossier_id = ANY($1::uuid[]) OR room_id = ANY($2::uuid[])", [ids, ownRooms]);
  await pool.query("DELETE FROM dossiers WHERE id = ANY($1::uuid[])", [ids]);
  await pool.query("DELETE FROM rooms WHERE id = ANY($1::uuid[])", [ownRooms]);
  await deleteOrphanDossiers(pool);
  // Nettoyage vérifié : plus rien de ce spec en base.
  const left = await pool.query(
    "SELECT (SELECT count(*) FROM dossiers WHERE guest_email = $1) + (SELECT count(*) FROM bookings WHERE guest_email = $1) AS n",
    [EMAIL],
  );
  expect(Number(left.rows[0].n)).toBe(0);
  await pool.end();
});

test("actions de la fiche Dossier : un Dossier d'un autre tenant ne bouge pas, le sien si", async () => {
  test.setTimeout(60_000);
  // Tenant A : deux chambres dédiées (une dans le Dossier, une à ajouter).
  for (const n of [1, 2]) {
    const { rows } = await pool.query(
      `INSERT INTO rooms (tenant_id, property_id, name, slug, price_per_night, capacity)
       SELECT tenant_id, property_id, $2, $3, '100.00', 2 FROM rooms WHERE id = $1 RETURNING id`,
      [ctx.apiRoomId, `Isolation ${n} ${STAMP}`, `dossier-isolation-${n}-${STAMP}`],
    );
    ownRooms.push(rows[0].id);
  }
  const own = await insertDossier(ctx.tenantId, ownRooms[0], `Isolation A ${STAMP}`);
  const rival = await insertDossier(ctx.rivalTenantId, ctx.rivalRoomId, `Isolation B ${STAMP}`);
  await pool.query(
    `INSERT INTO payments (tenant_id, dossier_id, stripe_session_id, amount, currency, status)
     VALUES ($1, $2, $3, '210.00', 'eur', 'paid')`,
    [ctx.rivalTenantId, rival.dossierId, `cs_test_isolation_${STAMP}`],
  );
  const before = await snapshot(rival.dossierId);

  const out = execFileSync(
    "npx",
    [
      "tsx",
      path.join(__dirname, "dossier-isolation-probe.ts"),
      ctx.tenantId,
      own.dossierId,
      ownRooms[1],
      rival.dossierId,
      rival.bookingId,
      ctx.rivalRoomId,
    ],
    { encoding: "utf8", timeout: 45_000 },
  );
  const r = JSON.parse(out.trim().split("\n").pop()!);

  // Tenant A sur le Dossier B : aucune ligne touchée, refus explicite pour les modifications.
  expect(r.cancelRoom).toEqual({ ok: [] });
  expect(r.cancelAll).toEqual({ ok: [] });
  expect(r.markPaid).toEqual({ ok: [] });
  expect(r.markUnpaid).toEqual({ ok: [] });
  expect(r.changeDates).toEqual({ error: "DossierActionError: Dossier introuvable." });
  expect(r.addRoom).toEqual({ error: "DossierActionError: Dossier introuvable." });
  expect(r.quote).toEqual({ ok: null });
  expect(await snapshot(rival.dossierId)).toEqual(before);
  // La chambre B ne rejoint pas un Dossier A (gate : chambre du tenant).
  expect(r.addRivalRoom).toEqual({ error: "Error: Chambre introuvable" });
  expect((await pool.query("SELECT 1 FROM bookings WHERE room_id = $1 AND tenant_id = $2", [ctx.rivalRoomId, ctx.tenantId])).rowCount).toBe(0);

  // Contrôle : sur son propre Dossier, le tenant A agit bien.
  expect(r.ownChangeDates).toEqual({ ok: [own.bookingId] });
  expect(r.ownMarkPaid).toEqual({ ok: [own.bookingId] });
  expect(r.ownCancelAll).toEqual({ ok: [own.bookingId] });
  const mine = await pool.query(
    "SELECT check_in::date::text AS ci, status, paid_at IS NOT NULL AS paid FROM bookings WHERE id = $1",
    [own.bookingId],
  );
  expect(mine.rows[0]).toEqual({ ci: "2036-03-10", status: "cancelled", paid: true });
  // Dossier annulé : ni nouvelles dates ni chambre ajoutée.
  expect(r.cancelledChangeDates.error).toMatch(/^DossierActionError: Ce Dossier est annulé ou terminé/);
  expect(r.cancelledAddRoom.error).toMatch(/^DossierActionError: Ce Dossier est annulé ou terminé/);
  expect((await pool.query("SELECT 1 FROM bookings WHERE dossier_id = $1", [own.dossierId])).rowCount).toBe(1);
});
