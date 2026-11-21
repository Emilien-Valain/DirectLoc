import { test, expect } from "@playwright/test";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { Pool } from "pg";
import { startSmtpSink } from "../helpers/smtp-sink";
import { mailBody, mailSubject } from "../helpers/mail-body";
import { confirmDialog } from "../helpers/confirm";

/**
 * Spécification : Tests de non-régression > Admin > Emails par Dossier
 * Issue `.scratch/dossiers/issues/04-dossier-emails.md`, ADR-0012.
 *
 * Un email par Dossier (confirmation, notification admin, rappel, remerciement,
 * expiration du paiement), annulation d'une chambre seule = email « annulation
 * partielle », annulation du reste = email d'annulation. Une chambre = contenu inchangé.
 *
 * Données : deux chambres dédiées, voyageurs au nom unique (STAMP), dates en 2036 ou autour
 * d'aujourd'hui pour le cron ; tout est supprimé en afterEach/afterAll.
 */

const ctx = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "e2e", ".auth", "test-context.json"), "utf-8"),
) as { tenantId: string; apiRoomId: string };

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? "whsec_test_XXXX";
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const STAMP = Date.now().toString(36);
const EMAIL = `dossier-mail-${STAMP}@example.com`;
const NAME_A = `Dossier Mail A ${STAMP}`;
const NAME_B = `Dossier Mail B ${STAMP}`;
const XSS_NAME = `<script>alert(1)</script> ${STAMP}`;

let roomA: string;
let roomB: string;
const dossierIds: string[] = [];

async function insertRoom(name: string, slug: string, beds: number, message: string) {
  const { rows } = await pool.query(
    `INSERT INTO rooms (tenant_id, property_id, name, slug, price_per_night, capacity, beds, email_message)
     SELECT tenant_id, property_id, $2, $3, '100.00', 3, $4, $5 FROM rooms WHERE id = $1 RETURNING id`,
    [ctx.apiRoomId, name, slug, beds, message],
  );
  return rows[0].id as string;
}

/** Dossier de 1 ou 2 chambres (A puis B), un seul voyageur. */
async function insertDossier(opts: {
  rooms: { roomId: string; total: string; guests: number }[];
  checkIn: string;
  checkOut: string;
  status: "pending" | "confirmed" | "completed";
  guestName?: string;
  createdAgo?: string;
  sessionId?: string;
}) {
  const name = opts.guestName ?? `Famille Mail ${STAMP}`;
  const { rows } = await pool.query(
    `INSERT INTO dossiers (tenant_id, check_in, check_out, guest_name, guest_email) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [ctx.tenantId, opts.checkIn, opts.checkOut, name, EMAIL],
  );
  const dossierId = rows[0].id as string;
  dossierIds.push(dossierId);
  const bookingIds: string[] = [];
  for (const r of opts.rooms) {
    const res = await pool.query(
      `INSERT INTO bookings (tenant_id, dossier_id, room_id, check_in, check_out, total_price, status, guest_name, guest_email, guest_count, source, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'direct', now() - $11::interval + ($12 || ' milliseconds')::interval) RETURNING id`,
      [ctx.tenantId, dossierId, r.roomId, opts.checkIn, opts.checkOut, r.total, opts.status, name, EMAIL, r.guests, opts.createdAgo ?? "1 minute", String(bookingIds.length)],
    );
    bookingIds.push(res.rows[0].id);
  }
  if (opts.sessionId) {
    await pool.query(
      `INSERT INTO payments (tenant_id, dossier_id, stripe_session_id, amount, currency, status) VALUES ($1, $2, $3, '0', 'eur', 'pending')`,
      [ctx.tenantId, dossierId, opts.sessionId],
    );
  }
  return { dossierId, bookingIds };
}

async function cleanup() {
  if (dossierIds.length === 0) return;
  await pool.query("DELETE FROM payments WHERE dossier_id = ANY($1::uuid[])", [dossierIds]);
  await pool.query("DELETE FROM bookings WHERE dossier_id = ANY($1::uuid[])", [dossierIds]);
  await pool.query("DELETE FROM dossiers WHERE id = ANY($1::uuid[])", [dossierIds]);
  dossierIds.length = 0;
}

function signature(payload: string) {
  const timestamp = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac("sha256", WEBHOOK_SECRET).update(`${timestamp}.${payload}`).digest("hex");
  return `t=${timestamp},v1=${sig}`;
}

function webhook(request: import("@playwright/test").APIRequestContext, type: string, sessionId: string, dossierId: string) {
  const payload = JSON.stringify({
    id: `evt_dmail_${Date.now()}_${Math.random()}`,
    type,
    data: { object: { id: sessionId, payment_intent: `pi_${sessionId}`, metadata: { dossierId, tenantId: ctx.tenantId } } },
  });
  return request.post("/api/webhooks/stripe", {
    data: payload,
    headers: { "content-type": "application/json", "stripe-signature": signature(payload) },
  });
}

const runCron = async (request: import("@playwright/test").APIRequestContext) => {
  const res = await request.get("/api/cron/booking-emails", { headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` } });
  expect(res.status()).toBe(200);
};

/** Aujourd'hui à Paris + n jours (YYYY-MM-DD) : le rappel compte en jours de Paris. */
const parisInDays = (n: number) => {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(new Date());
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
/** Date UTC (le cron remerciement cible « hier » en UTC). */
const utcInDays = (n: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const settle = () => new Promise((r) => setTimeout(r, 1500));
const tenantAdmins = async () =>
  (await pool.query("SELECT u.email FROM user_tenants ut JOIN users u ON u.id = ut.user_id WHERE ut.tenant_id = $1", [ctx.tenantId])).rows.map(
    (r) => r.email as string,
  );

test.describe("Emails par Dossier", () => {
  test.beforeAll(async () => {
    roomA = await insertRoom(NAME_A, `dossier-mail-a-${STAMP}`, 2, "Chambre {chambre} : {lits} lits pour {voyageurs} pers.");
    roomB = await insertRoom(NAME_B, `dossier-mail-b-${STAMP}`, 3, "Message <i>B</i> pour {client}");
  });
  test.afterEach(cleanup);
  test.afterAll(async () => {
    await cleanup();
    await pool.query("DELETE FROM rooms WHERE id = ANY($1::uuid[])", [[roomA, roomB]]);
    await pool.end();
  });

  test("Dossier de 2 chambres payé : 1 email de confirmation listant les 2 chambres, 1 notification par admin ; re-livraison sans doublon ; XSS échappé", async ({ request }) => {
    const sessionId = `cs_dmail_ok_${STAMP}`;
    const { dossierId } = await insertDossier({
      rooms: [
        { roomId: roomA, total: "270.00", guests: 2 },
        { roomId: roomB, total: "150.50", guests: 3 },
      ],
      checkIn: "2036-03-04",
      checkOut: "2036-03-07",
      status: "pending",
      guestName: XSS_NAME,
      sessionId,
    });
    const admins = await tenantAdmins();
    const sink = await startSmtpSink();
    try {
      expect((await webhook(request, "checkout.session.completed", sessionId, dossierId)).status()).toBe(200);
      const confirmations = () => sink.mails.filter((m) => m.to.includes(EMAIL) && mailSubject(m).startsWith("Confirmation de réservation"));
      const notifications = () => sink.mails.filter((m) => mailSubject(m).startsWith("Nouvelle réservation") && mailSubject(m).includes(STAMP));
      await expect.poll(() => confirmations().length).toBe(1);
      await expect.poll(() => notifications().length).toBe(admins.length);

      const body = mailBody(confirmations()[0]);
      expect(body).toContain(NAME_A);
      expect(body).toContain(NAME_B);
      expect(body).toContain("270.00 &euro;");
      expect(body).toContain("150.50 &euro;");
      expect(body).toContain("420.50 &euro;"); // total = somme des chambres
      // Message de chaque chambre avec SES variables.
      expect(body).toContain(`Chambre ${NAME_A} : 2 lits pour 2 pers.`);
      expect(body).toContain("Message &lt;i&gt;B&lt;/i&gt; pour &lt;script&gt;alert(1)&lt;/script&gt;");
      // XSS : rien n'est interprété ; vocabulaire voyageur sans « Dossier » (le nom de test contient « Dossier Mail »).
      expect(body).not.toContain("<script>alert(1)</script>");
      expect(body).not.toContain("<i>B</i>");
      expect(body.replace(new RegExp(`Dossier Mail [AB] ${STAMP}`, "g"), "")).not.toMatch(/Dossier/);

      const admin = mailBody(notifications()[0]);
      expect(admin).toContain(NAME_A);
      expect(admin).toContain(NAME_B);
      expect(admin).toContain("420.50 &euro;");
      expect(admin).not.toContain("<script>alert(1)</script>");

      // Re-livraison Stripe : rien de plus.
      await webhook(request, "checkout.session.completed", sessionId, dossierId);
      await settle();
      expect(confirmations()).toHaveLength(1);
      expect(notifications()).toHaveLength(admins.length);
    } finally {
      await sink.stop();
    }
  });

  test("une seule chambre : l'email de confirmation garde son contenu (ligne « Chambre », pas de liste)", async ({ request }) => {
    const sessionId = `cs_dmail_one_${STAMP}`;
    const { dossierId } = await insertDossier({
      rooms: [{ roomId: roomA, total: "300.00", guests: 2 }],
      checkIn: "2036-04-04",
      checkOut: "2036-04-07",
      status: "pending",
      sessionId,
    });
    const admins = await tenantAdmins();
    const sink = await startSmtpSink();
    try {
      await webhook(request, "checkout.session.completed", sessionId, dossierId);
      const confirmations = () => sink.mails.filter((m) => m.to.includes(EMAIL) && mailSubject(m).startsWith("Confirmation de réservation"));
      const notifications = () => sink.mails.filter((m) => mailSubject(m).includes(`(${NAME_A})`));
      await expect.poll(() => confirmations().length).toBe(1);
      await expect.poll(() => notifications().length).toBe(admins.length);
      const body = mailBody(confirmations()[0]);
      expect(body).toContain("Chambre</td>");
      expect(body).toContain(NAME_A);
      expect(body).toContain("300.00 &euro;");
      expect(body).not.toContain(NAME_B);
      expect(body).toContain(`Chambre ${NAME_A} : 2 lits pour 2 pers.`);
    } finally {
      await sink.stop();
    }
  });

  test("paiement expiré : 1 seul email d'annulation pour les 2 chambres ; re-livraison sans doublon", async ({ request }) => {
    const sessionId = `cs_dmail_exp_${STAMP}`;
    const { dossierId } = await insertDossier({
      rooms: [
        { roomId: roomA, total: "270.00", guests: 2 },
        { roomId: roomB, total: "150.00", guests: 2 },
      ],
      checkIn: "2036-05-04",
      checkOut: "2036-05-07",
      status: "pending",
      sessionId,
    });
    const sink = await startSmtpSink();
    try {
      await webhook(request, "checkout.session.expired", sessionId, dossierId);
      await webhook(request, "checkout.session.expired", sessionId, dossierId);
      const mails = () => sink.mails.filter((m) => m.to.includes(EMAIL));
      await expect.poll(() => mails().length).toBe(1);
      await settle();
      expect(mails()).toHaveLength(1);
      expect(mailSubject(mails()[0])).toContain("Réservation annulée");
      const body = mailBody(mails()[0]);
      expect(body).toContain(NAME_A);
      expect(body).toContain(NAME_B);
      expect(body).toContain("paiement n'a pas");
    } finally {
      await sink.stop();
    }
  });

  test("cron rappel : 1 email par Dossier de 2 chambres, relancé 2 fois et en parallèle → toujours 1 ; marqueur sur le Dossier", async ({ request }) => {
    const { dossierId } = await insertDossier({
      rooms: [
        { roomId: roomA, total: "270.00", guests: 2 },
        { roomId: roomB, total: "150.00", guests: 3 },
      ],
      checkIn: parisInDays(2),
      checkOut: parisInDays(4),
      status: "confirmed",
      createdAgo: "30 days",
    });
    const sink = await startSmtpSink();
    try {
      await Promise.all([runCron(request), runCron(request)]);
      await runCron(request);
      await settle();
      const mails = sink.mails.filter((m) => m.to.includes(EMAIL));
      expect(mails).toHaveLength(1);
      expect(mailSubject(mails[0])).toContain("Rappel");
      const body = mailBody(mails[0]);
      expect(body).toContain(NAME_A);
      expect(body).toContain(NAME_B);
      expect(body).toContain(`Chambre ${NAME_A} : 2 lits pour 2 pers.`);
      const { rows } = await pool.query("SELECT reminder_sent_at, thank_you_sent_at FROM dossiers WHERE id = $1", [dossierId]);
      expect(rows[0].reminder_sent_at).not.toBeNull();
      expect(rows[0].thank_you_sent_at).toBeNull();
    } finally {
      await sink.stop();
    }
  });

  test("cron rappel : une chambre annulée n'est pas listée ; Dossier réservé après le moment du rappel → rien", async ({ request }) => {
    await insertDossier({
      rooms: [
        { roomId: roomA, total: "270.00", guests: 2 },
        { roomId: roomB, total: "150.00", guests: 2 },
      ],
      checkIn: parisInDays(2),
      checkOut: parisInDays(4),
      status: "confirmed",
      createdAgo: "30 days",
    });
    await pool.query("UPDATE bookings SET status = 'cancelled' WHERE room_id = $1 AND guest_email = $2", [roomB, EMAIL]);
    const lateEmail = `late-${EMAIL}`;
    const late = await pool.query(
      `INSERT INTO dossiers (tenant_id, check_in, check_out, guest_name, guest_email) VALUES ($1, $2, $3, 'Tardif', $4) RETURNING id`,
      [ctx.tenantId, parisInDays(2), parisInDays(4), lateEmail],
    );
    dossierIds.push(late.rows[0].id);
    await pool.query(
      `INSERT INTO bookings (tenant_id, dossier_id, room_id, check_in, check_out, total_price, status, guest_name, guest_email, guest_count, source, created_at)
       VALUES ($1, $2, $3, $4::date, $5::date, '10', 'confirmed', 'Tardif', $6, 1, 'direct', GREATEST(now(), $4::date - interval '2 days' + interval '1 minute'))`,
      [ctx.tenantId, late.rows[0].id, roomA, parisInDays(2), parisInDays(4), lateEmail],
    );
    const sink = await startSmtpSink();
    try {
      await runCron(request);
      await settle();
      const mails = sink.mails.filter((m) => m.to.includes(EMAIL));
      expect(mails).toHaveLength(1);
      const body = mailBody(mails[0]);
      expect(body).toContain(NAME_A);
      expect(body).not.toContain(NAME_B);
      expect(sink.mails.filter((m) => m.to.includes(lateEmail))).toHaveLength(0);
    } finally {
      await sink.stop();
    }
  });

  test("cron remerciement : 1 email par Dossier de 2 chambres, relancé 2 fois → toujours 1", async ({ request }) => {
    const { dossierId } = await insertDossier({
      rooms: [
        { roomId: roomA, total: "270.00", guests: 2 },
        { roomId: roomB, total: "150.00", guests: 2 },
      ],
      checkIn: utcInDays(-3),
      checkOut: utcInDays(-1),
      status: "completed",
      createdAgo: "30 days",
    });
    const sink = await startSmtpSink();
    try {
      await Promise.all([runCron(request), runCron(request)]);
      await runCron(request);
      await settle();
      const mails = sink.mails.filter((m) => m.to.includes(EMAIL));
      expect(mails).toHaveLength(1);
      expect(mailSubject(mails[0])).toContain("Merci pour votre séjour");
      const body = mailBody(mails[0]);
      expect(body).toContain(NAME_A);
      expect(body).toContain(NAME_B);
      const { rows } = await pool.query("SELECT thank_you_sent_at FROM dossiers WHERE id = $1", [dossierId]);
      expect(rows[0].thank_you_sent_at).not.toBeNull();
    } finally {
      await sink.stop();
    }
  });

  test("annulation d'une chambre → « annulation partielle » ; annulation du reste → email d'annulation", async ({ page }) => {
    test.setTimeout(60000);
    const { dossierId, bookingIds } = await insertDossier({
      rooms: [
        { roomId: roomA, total: "270.00", guests: 2 },
        { roomId: roomB, total: "150.50", guests: 3 },
      ],
      checkIn: "2036-06-04",
      checkOut: "2036-06-07",
      status: "confirmed",
      guestName: XSS_NAME,
    });
    const sink = await startSmtpSink();
    try {
      await page.goto(`/admin/dossiers/${dossierId}`);
      await page.locator(`[data-dossier-room="${bookingIds[1]}"]`).getByRole("button", { name: "Annuler cette chambre" }).click();
      await confirmDialog(page);
      await expect(page).toHaveURL(/chambre-annulee=1$/);

      const mails = () => sink.mails.filter((m) => m.to.includes(EMAIL));
      await expect.poll(() => mails().length).toBe(1);
      expect(mailSubject(mails()[0])).toContain("Annulation partielle");
      const partial = mailBody(mails()[0]);
      // Chambre annulée, chambre maintenue, nouveau total = la chambre maintenue ; remboursement par l'hôte.
      expect(partial).toContain(NAME_B);
      expect(partial).toContain("150.50 &euro;");
      expect(partial).toContain(NAME_A);
      expect(partial).toContain("Nouveau total");
      expect(partial).toContain("270.00 &euro;");
      expect(partial).toContain("remboursement est effectu");
      expect(partial).not.toContain("<script>alert(1)</script>");

      await page.getByRole("button", { name: "Annuler tout le Dossier" }).click();
      await confirmDialog(page);
      await expect(page).toHaveURL(/annule=1$/);
      await expect.poll(() => mails().length).toBe(2);
      expect(mailSubject(mails()[1])).toContain("Réservation annulée");
      const total = mailBody(mails()[1]);
      expect(total).toContain(NAME_A);
      expect(total).not.toContain(NAME_B);
      expect(total).toContain("par l'&eacute;tablissement");
    } finally {
      await sink.stop();
    }
  });

  test("annulation du Dossier entier d'un coup → 1 seul email d'annulation listant les 2 chambres", async ({ page }) => {
    const { dossierId } = await insertDossier({
      rooms: [
        { roomId: roomA, total: "270.00", guests: 2 },
        { roomId: roomB, total: "150.00", guests: 2 },
      ],
      checkIn: "2036-07-04",
      checkOut: "2036-07-07",
      status: "confirmed",
    });
    const sink = await startSmtpSink();
    try {
      await page.goto(`/admin/dossiers/${dossierId}`);
      await page.getByRole("button", { name: "Annuler tout le Dossier" }).click();
      await confirmDialog(page);
      await expect(page).toHaveURL(/annule=1$/);
      const mails = () => sink.mails.filter((m) => m.to.includes(EMAIL));
      await expect.poll(() => mails().length).toBe(1);
      await settle();
      expect(mails()).toHaveLength(1);
      expect(mailSubject(mails()[0])).toContain("Réservation annulée");
      const body = mailBody(mails()[0]);
      expect(body).toContain(NAME_A);
      expect(body).toContain(NAME_B);
    } finally {
      await sink.stop();
    }
  });
});
