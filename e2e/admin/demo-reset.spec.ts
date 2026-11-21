import { test, expect } from "@playwright/test";
import { Pool } from "pg";

/**
 * Spécification : Tests de non-régression > Admin > Démo — reset nocturne
 *
 * GET /api/cron/demo-reset remet l'hôtel démo (DEMO_TENANT_SLUG = demo-tenant côté
 * webServer) dans son état de référence, sans jamais toucher un autre tenant.
 */

const DEMO = "demo-tenant";
const URL = "/api/cron/demo-reset";
const auth = { Authorization: `Bearer ${process.env.CRON_SECRET}` };

const TABLES = [
  "properties",
  "rooms",
  "bookings",
  "dossiers",
  "payments",
  "extras",
  "fees",
  "ical_sources",
  "ical_blocks",
  "manual_blocks",
  "booking_rules",
  "pricing_rules",
  "user_tenants",
] as const;

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL! });
test.afterAll(() => pool.end());

async function counts(slug: string) {
  const out: Record<string, number> = {};
  for (const table of TABLES) {
    const { rows } = await pool.query(
      `select count(*)::int as n from ${table} where tenant_id = (select id from tenants where slug = $1)`,
      [slug],
    );
    out[table] = rows[0].n;
  }
  const { rows } = await pool.query(
    `select count(*)::int as n from booking_lines bl join bookings b on b.id = bl.booking_id
     where b.tenant_id = (select id from tenants where slug = $1)`,
    [slug],
  );
  out.booking_lines = rows[0].n;
  return out;
}

test.describe("Cron — reset de l'hôtel démo", () => {
  test("sans secret ou avec un mauvais secret → 401", async ({ request }) => {
    expect((await request.get(URL)).status()).toBe(401);
    expect((await request.get(URL, { headers: { Authorization: "Bearer mauvais" } })).status()).toBe(401);
  });

  test("avec secret → 200 et le jeu de démo attendu", async ({ request }) => {
    const res = await request.get(URL, { headers: auth });
    expect(res.status()).toBe(200);
    expect(await res.json()).toMatchObject({ rooms: 4, bookings: 18 });

    const c = await counts(DEMO);
    expect(c).toMatchObject({
      properties: 1,
      rooms: 4,
      bookings: 18,
      dossiers: 18, // un Dossier d'une chambre par réservation (ADR-0012)
      payments: 0,
      manual_blocks: 1,
      booking_rules: 1,
      pricing_rules: 1,
      ical_sources: 1,
      ical_blocks: 2,
    });

    // Statuts et canaux variés, réservations de part et d'autre d'aujourd'hui.
    const { rows } = await pool.query(
      `select count(distinct status)::int as statuses, count(distinct source)::int as sources,
              bool_or(check_in < now()) as past, bool_or(check_in > now()) as future
       from bookings where tenant_id = (select id from tenants where slug = $1)`,
      [DEMO],
    );
    expect(rows[0]).toEqual({ statuses: 4, sources: 2, past: true, future: true });

    const { rows: tenant } = await pool.query(
      `select name, config->>'template' as template, config->>'heroTitle' as hero from tenants where slug = $1`,
      [DEMO],
    );
    expect(tenant[0]).toMatchObject({ name: "Le Mas des Oliviers", template: "classic" });
    expect(tenant[0].hero).toBeTruthy();
  });

  test("une modification faite avant reset a disparu après", async ({ request }) => {
    await pool.query(
      `update rooms set name = 'Modifiée E2E' where slug = 'chambre-lavande'
         and tenant_id = (select id from tenants where slug = $1)`,
      [DEMO],
    );
    await pool.query(`update tenants set name = 'Renommé E2E' where slug = $1`, [DEMO]);

    expect((await request.get(URL, { headers: auth })).status()).toBe(200);

    const { rows } = await pool.query(
      `select r.name, t.name as tenant from rooms r join tenants t on t.id = r.tenant_id
       where t.slug = $1 and r.slug = 'chambre-lavande'`,
      [DEMO],
    );
    expect(rows).toEqual([{ name: "Chambre Lavande", tenant: "Le Mas des Oliviers" }]);
  });

  test("un admin rattaché à la démo (ex. create-admin) est détaché ; seul le compte démo reste", async ({ request }) => {
    // Admin d'un autre tenant : seul son lien vers la démo doit disparaître.
    const { rows: [other] } = await pool.query(
      `select ut.user_id from user_tenants ut join tenants t on t.id = ut.tenant_id where t.slug = 'test-tenant' limit 1`,
    );
    await pool.query(
      `insert into user_tenants (user_id, tenant_id) select $1, id from tenants where slug = $2 on conflict do nothing`,
      [other.user_id, DEMO],
    );

    expect((await request.get(URL, { headers: auth })).status()).toBe(200);

    const { rows } = await pool.query(
      `select u.email from user_tenants ut join users u on u.id = ut.user_id
       join tenants t on t.id = ut.tenant_id where t.slug = $1`,
      [DEMO],
    );
    expect(rows).toEqual([{ email: "demo@demo.local" }]);
    const { rows: kept } = await pool.query(
      `select 1 from user_tenants ut join tenants t on t.id = ut.tenant_id where t.slug = 'test-tenant' and ut.user_id = $1`,
      [other.user_id],
    );
    expect(kept).toHaveLength(1);
  });

  test("deux resets de suite donnent le même nombre de lignes", async ({ request }) => {
    expect((await request.get(URL, { headers: auth })).status()).toBe(200);
    const first = await counts(DEMO);
    expect((await request.get(URL, { headers: auth })).status()).toBe(200);
    expect(await counts(DEMO)).toEqual(first);
  });

  test("les autres tenants sont strictement inchangés", async ({ request }) => {
    const others = ["test-tenant", "rival-hotel"];
    const before = await Promise.all(others.map(counts));
    const { rows: cfgBefore } = await pool.query(
      `select slug, name, domain, config from tenants where slug = any($1) order by slug`,
      [others],
    );

    expect((await request.get(URL, { headers: auth })).status()).toBe(200);

    expect(await Promise.all(others.map(counts))).toEqual(before);
    const { rows: cfgAfter } = await pool.query(
      `select slug, name, domain, config from tenants where slug = any($1) order by slug`,
      [others],
    );
    expect(cfgAfter).toEqual(cfgBefore);
  });
});
