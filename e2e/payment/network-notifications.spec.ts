import crypto from "crypto";
import { Pool } from "pg";
import { test, expect, type APIRequestContext } from "@playwright/test";
import { startSmtpSink, type CapturedMail } from "../helpers/smtp-sink";
import { mailText as mailBody, mailSubject } from "../helpers/mail-body";

/**
 * Spécification : Tests de non-régression > Paiement > Réseau des Voisins : notifications de Renvoi.
 * Issue `.scratch/reseau-voisins/issues/04-referral-notifications.md`, ADR-0013.
 *
 * Tenants dédiés (slugs aléatoires, zone GPS vide), chacun avec un admin qui reçoit les emails,
 * tous supprimés à la fin avec Renvois, Dossiers, réservations, paiements et utilisateurs :
 *  - A : l'hôte qui envoie (nom piégé XSS, téléphone) ; B : le Voisin qui reçoit (nom piégé XSS, téléphone).
 * Les emails sont lus sur un faux serveur SMTP (port 1025).
 */

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? "whsec_test_XXXX";
const BASE_URL = "http://localhost:3001";
const S = Math.random().toString(36).slice(2, 8);
const slug = { a: `nna-${S}`, b: `nnb-${S}` };
const NAME = { a: `Moulin <script>alert(1)</script> d'Amont ${S}`, b: `Gîte <img src=x onerror=alert(2)> d'Aval ${S}` };
const PHONE = { a: "02 51 00 00 01", b: "02 51 00 00 02" };
const ADMIN = { a: `nn-admin-a-${S}@example.test`, b: `nn-admin-b-${S}@example.test` };
const T: Record<string, string> = {};
const ROOM: Record<string, string> = {};
const USERS: string[] = [];
const GUEST = { name: "Zébulon Voyageur", email: `zebulon-${S}@guest.test`, phone: "06 98 76 54 32" };
const GUEST_A = { name: "Hortense Groupe", email: `hortense-${S}@guest.test`, phone: "06 12 12 12 12" };

const IN = "2034-05-10";
const OUT = "2034-05-13";

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
let sink: Awaited<ReturnType<typeof startSmtpSink>>;

async function makeTenant(key: "a" | "b", lat: number) {
  const { rows } = await pool.query(
    `INSERT INTO tenants (slug, name, domain, config) VALUES ($1, $2, $3, $4::jsonb) RETURNING id`,
    [slug[key], NAME[key], `${slug[key]}.example.test`, JSON.stringify({ latitude: lat, longitude: 26, phone: PHONE[key] })],
  );
  T[key] = rows[0].id;
  const { rows: [prop] } = await pool.query("INSERT INTO properties (tenant_id, name) VALUES ($1, $2) RETURNING id", [T[key], "Maison"]);
  const r = await pool.query(
    `INSERT INTO rooms (tenant_id, property_id, name, slug, price_per_night, capacity) VALUES ($1, $2, 'Chambre', 'ch-1', '90.00', 4) RETURNING id`,
    [T[key], prop.id],
  );
  ROOM[key] = r.rows[0].id;
  const userId = `nn-${key}-${S}`;
  await pool.query("INSERT INTO users (id, name, email, email_verified) VALUES ($1, $2, $3, true)", [userId, `Admin ${key}`, ADMIN[key]]);
  await pool.query("INSERT INTO user_tenants (user_id, tenant_id) VALUES ($1, $2)", [userId, T[key]]);
  USERS.push(userId);
}

/** Dossier d'une chambre (pending ou confirmed) + son paiement en attente ; id du Dossier et de la session. */
async function dossierAt(key: "a" | "b", opts: { referredBy?: string | null; status?: "pending" | "confirmed"; guest?: typeof GUEST } = {}) {
  const g = opts.guest ?? GUEST;
  const { rows } = await pool.query(
    `INSERT INTO dossiers (tenant_id, check_in, check_out, guest_name, guest_email, guest_phone, referred_by_tenant_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [T[key], IN, OUT, g.name, g.email, g.phone, opts.referredBy ?? null],
  );
  const dossierId = rows[0].id as string;
  await pool.query(
    `INSERT INTO bookings (tenant_id, dossier_id, room_id, check_in, check_out, total_price, status, guest_name, guest_email, guest_phone, guest_count, source)
     VALUES ($1, $2, $3, $4, $5, '270.00', $6, $7, $8, $9, 2, 'direct')`,
    [T[key], dossierId, ROOM[key], IN, OUT, opts.status ?? "pending", g.name, g.email, g.phone],
  );
  const sessionId = `cs_test_nn_${S}_${Math.random().toString(36).slice(2)}`;
  await pool.query(
    `INSERT INTO payments (tenant_id, dossier_id, stripe_session_id, amount, currency, status) VALUES ($1, $2, $3, '270.00', 'eur', 'pending')`,
    [T[key], dossierId, sessionId],
  );
  return { dossierId, sessionId };
}

function generateStripeSignature(payload: string, secret: string): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = crypto.createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

function paid(request: APIRequestContext, key: "a" | "b", d: { dossierId: string; sessionId: string }) {
  const payload = JSON.stringify({
    id: `evt_nn_${Date.now()}_${Math.random()}`,
    type: "checkout.session.completed",
    data: { object: { id: d.sessionId, payment_intent: `pi_${d.sessionId}`, metadata: { dossierId: d.dossierId, tenantId: T[key] } } },
  });
  return request.post(`${BASE_URL}/api/webhooks/stripe`, {
    data: payload,
    headers: { "content-type": "application/json", "stripe-signature": generateStripeSignature(payload, WEBHOOK_SECRET) },
  });
}

/** Emails du réseau seulement (les emails de confirmation habituels partent aussi). */
const networkMails = () =>
  sink.mails.filter((m) => /réseau DirectLoc|Réseau DirectLoc|Groupe partagé avec/.test(mailSubject(m)));
const to = (m: CapturedMail) => m.to.join(",");
const mailFor = (who: string, subject: RegExp) => networkMails().find((m) => to(m) === who && subject.test(mailSubject(m)));

async function purge() {
  const ids = Object.values(T);
  if (ids.length === 0) return;
  await pool.query("DELETE FROM referrals WHERE from_tenant_id = ANY($1::uuid[]) OR to_tenant_id = ANY($1::uuid[])", [ids]);
  await pool.query("DELETE FROM payments WHERE tenant_id = ANY($1::uuid[])", [ids]);
  await pool.query("DELETE FROM booking_lines WHERE booking_id IN (SELECT id FROM bookings WHERE tenant_id = ANY($1::uuid[]))", [ids]);
  await pool.query("DELETE FROM bookings WHERE tenant_id = ANY($1::uuid[])", [ids]);
  await pool.query("DELETE FROM dossiers WHERE tenant_id = ANY($1::uuid[])", [ids]);
}

test.describe("Paiement — Réseau des Voisins : notifications de Renvoi", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    await makeTenant("a", 26);
    await makeTenant("b", 26.1); // ~11 km
    sink = await startSmtpSink();
  });

  test.afterEach(async () => {
    await purge();
    sink.mails.length = 0;
  });

  test.afterAll(async () => {
    await sink?.stop();
    await purge();
    const ids = Object.values(T);
    await pool.query("DELETE FROM users WHERE id = ANY($1::text[])", [USERS]);
    await pool.query("DELETE FROM rooms WHERE tenant_id = ANY($1::uuid[])", [ids]);
    await pool.query("DELETE FROM properties WHERE tenant_id = ANY($1::uuid[])", [ids]);
    await pool.query("DELETE FROM tenants WHERE id = ANY($1::uuid[])", [ids]);
    await pool.end();
  });

  test("Dossier attribué payé → 2 emails (Voisin, envoyeur) ; envoyeur sans donnée voyageur ; noms échappés ; webhook rejoué → aucun 2ᵉ email", async ({ request }) => {
    const d = await dossierAt("b", { referredBy: T.a });
    expect((await paid(request, "b", d)).status()).toBe(200);

    expect(networkMails()).toHaveLength(2);
    const received = mailFor(ADMIN.b, /^Réservation obtenue grâce à /);
    const sent = mailFor(ADMIN.a, /^Réseau DirectLoc : le voyageur orienté vers /);
    expect(received, "email au Voisin").toBeTruthy();
    expect(sent, "email à l'envoyeur").toBeTruthy();
    expect(mailSubject(received!)).toBe(`Réservation obtenue grâce à ${NAME.a} (réseau DirectLoc)`);

    const sentBody = mailBody(sent!);
    expect(sentBody).toContain("Votre établissement était complet du 10 mai 2034 au 13 mai 2034");
    expect(sentBody).toContain("le voyageur que vous avez orienté vers");
    // Aucune donnée voyageur chez l'envoyeur (nom, email, téléphone).
    for (const leak of [GUEST.name, "Zébulon", GUEST.email, GUEST.phone, "zebulon"]) expect(sentBody, leak).not.toContain(leak);
    // Groupe non partagé : pas d'échange de contacts.
    expect(sentBody).not.toContain("data-network-partner");
    expect(sentBody).not.toContain(PHONE.b);

    // Noms des tenants échappés dans les deux corps.
    const receivedBody = mailBody(received!);
    expect(receivedBody).toContain("Moulin &lt;script&gt;alert(1)&lt;/script&gt; d&#039;Amont");
    expect(sentBody).toContain("Gîte &lt;img src=x onerror=alert(2)&gt; d&#039;Aval");
    for (const body of [sentBody, receivedBody]) {
      expect(body).not.toContain("<script>alert(1)");
      expect(body).not.toContain("<img src=x");
    }
    const { rows } = await pool.query("SELECT network_notified_at FROM dossiers WHERE id = $1", [d.dossierId]);
    expect(rows[0].network_notified_at).not.toBeNull();

    // Stripe rejoue l'événement (deux fois) : aucun nouvel email du réseau.
    expect((await paid(request, "b", d)).status()).toBe(200);
    expect((await paid(request, "b", d)).status()).toBe(200);
    expect(networkMails()).toHaveLength(2);
  });

  test("Dossier non attribué payé → aucun email du réseau ; marqueur posé ailleurs → aucun email", async ({ request }) => {
    const direct = await dossierAt("b");
    expect((await paid(request, "b", direct)).status()).toBe(200);
    expect(sink.mails.length).toBeGreaterThan(0); // la confirmation habituelle est bien partie
    expect(networkMails()).toHaveLength(0);

    // Déjà notifié (marqueur posé) : la confirmation ne renvoie rien.
    const done = await dossierAt("b", { referredBy: T.a });
    await pool.query("UPDATE dossiers SET network_notified_at = now() WHERE id = $1", [done.dossierId]);
    expect((await paid(request, "b", done)).status()).toBe(200);
    expect(networkMails()).toHaveLength(0);
  });

  test("groupe partagé, l'hôte payé d'abord : Renvoi relié aux deux Dossiers, chaque hôte reçoit nom + téléphone de l'autre, sans donnée voyageur", async ({ request }) => {
    // A loge une partie du groupe (payé) puis, depuis sa page de confirmation, envoie le reste chez B.
    const hostSide = await dossierAt("a", { guest: GUEST_A });
    expect((await paid(request, "a", hostSide)).status()).toBe(200);
    expect(networkMails()).toHaveLength(0); // le Dossier de A n'est pas attribué

    const res = await request.get(
      `http://${slug.a}.localhost:3001/voisin/${slug.b}?checkIn=${IN}&checkOut=${OUT}&adults=2&minors=0&kind=shared&dossier=${hostSide.dossierId}`,
      { maxRedirects: 0, headers: { "x-forwarded-for": `10.41.${Math.floor(Math.random() * 250)}.7` } },
    );
    expect(res.status()).toBe(302);
    // Le Dossier de A ne part pas chez B.
    expect(res.headers()["location"]).not.toContain(hostSide.dossierId);
    expect(new URL(res.headers()["location"]).searchParams.get("dossier")).toBeNull();
    const { rows: refs } = await pool.query("SELECT id, from_dossier_id, to_dossier_id FROM referrals WHERE from_tenant_id = $1", [T.a]);
    expect(refs).toEqual([{ id: refs[0].id, from_dossier_id: hostSide.dossierId, to_dossier_id: null }]);

    const voisinSide = await dossierAt("b", { referredBy: T.a });
    expect((await paid(request, "b", voisinSide)).status()).toBe(200);

    const { rows: linked } = await pool.query("SELECT to_dossier_id, share_notified_at FROM referrals WHERE id = $1", [refs[0].id]);
    expect(linked[0].to_dossier_id).toBe(voisinSide.dossierId);
    expect(linked[0].share_notified_at).not.toBeNull();

    // Les 2 emails d'attribution portent le contact de l'autre hôte (pas de 3ᵉ/4ᵉ email).
    expect(networkMails()).toHaveLength(2);
    const received = mailBody(mailFor(ADMIN.b, /^Réservation obtenue grâce à /)!);
    const sent = mailBody(mailFor(ADMIN.a, /^Réseau DirectLoc : /)!);
    expect(received).toContain("data-network-partner");
    expect(received).toContain(PHONE.a);
    expect(received).toContain("Moulin &lt;script&gt;");
    expect(sent).toContain("data-network-partner");
    expect(sent).toContain(PHONE.b);
    expect(sent).toContain("ne pouvait pas loger tout le groupe du 10 mai 2034 au 13 mai 2034");
    // Les voyageurs restent chez leur hôte : aucun ne passe chez l'autre.
    for (const leak of [GUEST.name, GUEST.email, GUEST.phone]) expect(sent, leak).not.toContain(leak);
    for (const leak of [GUEST_A.name, GUEST_A.email, GUEST_A.phone]) expect(received, leak).not.toContain(leak);

    // Rejeu des deux webhooks : rien de plus.
    await paid(request, "b", voisinSide);
    await paid(request, "a", hostSide);
    expect(networkMails()).toHaveLength(2);
  });

  test("groupe partagé, le Voisin payé avant l'hôte : attribution sans contact, puis contacts échangés à la confirmation de l'hôte (une fois)", async ({ request }) => {
    const hostSide = await dossierAt("a", { guest: GUEST_A }); // pending
    await pool.query(
      `INSERT INTO referrals (from_tenant_id, to_tenant_id, check_in, check_out, guest_count, kind, from_dossier_id)
       VALUES ($1, $2, $3, $4, 2, 'shared', $5)`,
      [T.a, T.b, IN, OUT, hostSide.dossierId],
    );
    const voisinSide = await dossierAt("b", { referredBy: T.a });
    expect((await paid(request, "b", voisinSide)).status()).toBe(200);
    expect(networkMails()).toHaveLength(2);
    expect(mailBody(mailFor(ADMIN.a, /^Réseau DirectLoc : /)!)).not.toContain("data-network-partner");

    expect((await paid(request, "a", hostSide)).status()).toBe(200);
    expect(networkMails()).toHaveLength(4);
    const forA = mailFor(ADMIN.a, /^Groupe partagé avec /)!;
    const forB = mailFor(ADMIN.b, /^Groupe partagé avec /)!;
    expect(mailSubject(forA)).toBe(`Groupe partagé avec ${NAME.b} : les deux réservations sont confirmées`);
    expect(mailBody(forA)).toContain(PHONE.b);
    expect(mailBody(forB)).toContain(PHONE.a);
    for (const leak of [GUEST.name, GUEST.email, GUEST.phone]) expect(mailBody(forA), leak).not.toContain(leak);
    for (const leak of [GUEST_A.name, GUEST_A.email, GUEST_A.phone]) expect(mailBody(forB), leak).not.toContain(leak);

    await paid(request, "a", hostSide);
    expect(networkMails()).toHaveLength(4);
  });

  test("/voisin partagé : Dossier d'un autre tenant, aux mauvaises dates, inconnu ou forgé → Renvoi enregistré sans lien", async ({ request }) => {
    const ofB = await dossierAt("b"); // pas un Dossier de A
    const ofAOtherDates = await dossierAt("a", { guest: GUEST_A });
    await pool.query("UPDATE dossiers SET check_out = '2034-05-14' WHERE id = $1", [ofAOtherDates.dossierId]);
    for (const dossier of [ofB.dossierId, ofAOtherDates.dossierId, crypto.randomUUID(), "pas-un-uuid", "' OR 1=1--"]) {
      const res = await request.get(
        `http://${slug.a}.localhost:3001/voisin/${slug.b}?checkIn=${IN}&checkOut=${OUT}&adults=2&kind=shared&dossier=${encodeURIComponent(dossier)}`,
        { maxRedirects: 0, headers: { "x-forwarded-for": `10.42.${Math.floor(Math.random() * 250)}.9` } },
      );
      expect(res.status(), dossier).toBe(302);
    }
    const { rows } = await pool.query("SELECT from_dossier_id FROM referrals WHERE from_tenant_id = $1", [T.a]);
    expect(rows).toHaveLength(5);
    for (const r of rows) expect(r.from_dossier_id).toBeNull();
  });
});
