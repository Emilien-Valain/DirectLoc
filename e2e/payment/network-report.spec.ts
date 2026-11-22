import { Pool } from "pg";
import { test, expect } from "@playwright/test";
import { startSmtpSink } from "../helpers/smtp-sink";
import { mailBody, mailText, mailSubject } from "../helpers/mail-body";

/**
 * Spécification : Tests de non-régression > Paiement > Réseau : Bilan mensuel (cron du 1er).
 * Issue `.scratch/reseau-voisins/issues/05-network-counter-and-monthly-report.md`.
 * Tenants dédiés (A : activité le mois dernier, nom piégé XSS ; B : voisin ; C : aucune activité ; D : activité d'il y a 2 mois seulement),
 * chacun avec un admin qui reçoit les emails (faux SMTP, port 1025). Tout est supprimé à la fin.
 */
const S = Math.random().toString(36).slice(2, 8);
const NAME_A = `Moulin <script>alert(1)</script> ${S}`;
const T: Record<string, string> = {};
const ADMIN: Record<string, string> = {};
const USERS: string[] = [];
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
let sink: Awaited<ReturnType<typeof startSmtpSink>>;
const auth = { Authorization: `Bearer ${process.env.CRON_SECRET}` };

async function makeTenant(key: string, name: string) {
  const { rows } = await pool.query(`INSERT INTO tenants (slug, name, domain, config) VALUES ($1, $2, $3, '{}'::jsonb) RETURNING id`, [`nr${key}-${S}`, name, `nr${key}-${S}.example.test`]);
  T[key] = rows[0].id;
  ADMIN[key] = `nr-${key}-${S}@example.test`;
  await pool.query("INSERT INTO users (id, name, email, email_verified) VALUES ($1, $2, $3, true)", [`nr-${key}-${S}`, `Admin ${key}`, ADMIN[key]]);
  await pool.query("INSERT INTO user_tenants (user_id, tenant_id) VALUES ($1, $2)", [`nr-${key}-${S}`, T[key]]);
  USERS.push(`nr-${key}-${S}`);
}
const ref = (from: string, to: string, when: string) =>
  pool.query(
    `INSERT INTO referrals (from_tenant_id, to_tenant_id, check_in, check_out, guest_count, kind, created_at)
     VALUES ($1, $2, '2036-03-01', '2036-03-04', 2, 'full', ${when})`,
    [T[from], T[to]],
  );
const LAST = "(date_trunc('month', now() at time zone 'utc') - interval '10 days')";
const OLDER = "(date_trunc('month', now() at time zone 'utc') - interval '40 days')";
const mine = () => sink.mails.filter((m) => Object.values(ADMIN).some((a) => m.to.includes(a)));
const bilans = (key: string) => mine().filter((m) => m.to.includes(ADMIN[key]) && /bilan/i.test(mailSubject(m)));

test.beforeAll(async () => {
  await makeTenant("a", NAME_A);
  await makeTenant("b", `Gîte B ${S}`);
  await makeTenant("c", `Hôtel C ${S}`);
  await makeTenant("d", `Hôtel D ${S}`);
  sink = await startSmtpSink();
});

test.afterAll(async () => {
  await sink?.stop();
  const ids = Object.values(T);
  await pool.query("DELETE FROM referrals WHERE from_tenant_id = ANY($1::uuid[]) OR to_tenant_id = ANY($1::uuid[])", [ids]);
  await pool.query("DELETE FROM network_reports WHERE tenant_id = ANY($1::uuid[])", [ids]);
  await pool.query("DELETE FROM users WHERE id = ANY($1::text[])", [USERS]);
  await pool.query("DELETE FROM tenants WHERE id = ANY($1::uuid[])", [ids]);
  await pool.end();
});

test("cron sans secret ou avec mauvais secret → 401, jamais 200", async ({ request }) => {
  expect((await request.get("/api/cron/network-report")).status()).toBe(401);
  const bad = await request.get("/api/cron/network-report", { headers: { Authorization: "Bearer mauvais" } });
  expect(bad.status()).toBe(401);
});

test("activité le mois dernier → exactement 1 Bilan par hôtel concerné ; sans activité ou trop ancienne → aucun ; rejeu → aucun doublon ; nom échappé", async ({ request }) => {
  await ref("a", "b", LAST);
  await ref("a", "b", LAST);
  await ref("b", "a", LAST);
  await ref("d", "b", OLDER); // il y a 2 mois : ne déclenche rien pour D
  await ref("b", "d", "(now() at time zone 'utc')"); // ce mois-ci : ne compte pas pour le Bilan de D

  const res = await request.get("/api/cron/network-report", { headers: auth });
  expect(res.status()).toBe(200);

  expect(bilans("a")).toHaveLength(1);
  expect(bilans("b")).toHaveLength(1);
  expect(bilans("c")).toHaveLength(0);
  expect(bilans("d")).toHaveLength(0);

  const a = bilans("a")[0];
  const strip = (m: Parameters<typeof mailText>[0]) => mailText(m).replace(/<[^>]*>/g, "");
  const text = strip(a);
  expect(text).toMatch(/2\s+voyageurs orientés/);
  expect(text).toMatch(/1\s+voyageur reçu/);
  expect(text).toMatch(/0\s+réservation/);
  // B : 1 envoyé, 2 reçus ; aucun chiffre de A dans l'email de B.
  const b = strip(bilans("b")[0]);
  expect(b).toMatch(/1\s+voyageur orienté/);
  expect(b).toMatch(/2\s+voyageurs reçus/);
  // Nom échappé : pas de balise injectée dans le HTML.
  const html = mailBody(a);
  expect(html).not.toContain("<script>alert(1)</script>");
  expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");

  // Rejeu du cron : aucun 2e Bilan.
  const again = await request.get("/api/cron/network-report", { headers: auth });
  expect(again.status()).toBe(200);
  expect(bilans("a")).toHaveLength(1);
  expect(bilans("b")).toHaveLength(1);
});
