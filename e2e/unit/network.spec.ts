import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { Pool } from "pg";

/**
 * Réseau des Voisins (ADR-0013) : la lecture entre tenants (`lib/network.ts`) sur la base de test,
 * via une sonde tsx (comme `dossier-isolation.spec.ts`). Tenants dédiés au spec, supprimés à la fin.
 * Les tenants du seed (test-tenant…) peuvent aussi être Voisins : on filtre sur le préfixe du run.
 */
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const STAMP = Date.now().toString(36);
const P = `net-${STAMP}`;
const slugs = ["origin", "near", "ruled", "far", "nogps", "off", "nodomain", "nocap"].map((s) => `${P}-${s}`);
const id: Record<string, string> = {};

const gps = (dLat: number) => ({ latitude: 20 + dLat, longitude: 20 }); // zone vide : loin des tenants du seed

async function makeTenant(key: string, config: object, opts: { domain?: boolean; rooms?: number[] } = {}) {
  const slug = `${P}-${key}`;
  const { rows } = await pool.query(
    `INSERT INTO tenants (slug, name, domain, config) VALUES ($1, $2, $3, $4) RETURNING id`,
    [slug, `Hôtel ${key}`, opts.domain === false ? null : `${slug}.example.test`, JSON.stringify(config)],
  );
  id[key] = rows[0].id;
  const prop = await pool.query(`INSERT INTO properties (tenant_id, name) VALUES ($1, $2) RETURNING id`, [id[key], `P ${key}`]);
  for (const [i, cap] of (opts.rooms ?? []).entries()) {
    await pool.query(
      `INSERT INTO rooms (tenant_id, property_id, name, slug, price_per_night, capacity) VALUES ($1, $2, $3, $4, '100.00', $5)`,
      [id[key], prop.rows[0].id, `Chambre ${i + 1}`, `ch-${i + 1}`, cap],
    );
  }
}

function probe(origin: string, checkIn: string, checkOut: string, adults: number, minors: number, env: Record<string, string> = {}) {
  const out = execFileSync(
    "npx",
    ["tsx", path.join(__dirname, "network-probe.ts"), origin, checkIn, checkOut, String(adults), String(minors)],
    { encoding: "utf8", timeout: 60_000, env: { ...process.env, ...env } },
  );
  const all = JSON.parse(out.trim().split("\n").pop()!) as Record<string, unknown>[];
  return all.filter((v) => String(v.slug).startsWith(P));
}

test.beforeAll(async () => {
  await makeTenant("origin", { ...gps(0), phone: "+33100000000" }, { rooms: [2] });
  await makeTenant("near", { ...gps(0.1), city: "Les Épesses", phone: "+33 2 51 00 00 00", heroPhoto: { id: "h", filename: "h.jpg", url: "/p/h.jpg" } }, { rooms: [2, 2] });
  await makeTenant("ruled", { ...gps(0.2), galleryPhotos: [{ id: "g", filename: "g.jpg", url: "/p/g.jpg" }] }, { rooms: [4] });
  await makeTenant("far", { ...gps(0.5) }, { rooms: [3] });
  await makeTenant("nogps", {}, { rooms: [10] });
  await makeTenant("off", { ...gps(0.05), networkEnabled: false }, { rooms: [10] });
  await makeTenant("nodomain", { ...gps(0.05) }, { domain: false, rooms: [10] });
  await makeTenant("nocap", { ...gps(0.7) }, { rooms: [] });
  // Règle du Voisin « ruled » : 3 nuits minimum -> un séjour de 2 nuits y est refusé.
  await pool.query(`INSERT INTO booking_rules (tenant_id, min_stay) VALUES ($1, 3)`, [id.ruled]);
});

test.afterAll(async () => {
  const ids = Object.values(id);
  await pool.query("DELETE FROM booking_rules WHERE tenant_id = ANY($1::uuid[])", [ids]);
  await pool.query("DELETE FROM rooms WHERE tenant_id = ANY($1::uuid[])", [ids]);
  await pool.query("DELETE FROM properties WHERE tenant_id = ANY($1::uuid[])", [ids]);
  await pool.query("DELETE FROM tenants WHERE id = ANY($1::uuid[])", [ids]);
  const left = await pool.query("SELECT count(*)::int AS n FROM tenants WHERE slug LIKE $1", [`${P}-%`]);
  expect(left.rows[0].n).toBe(0);
  await pool.end();
});

test("findVoisins : tri par distance, exclusions, règles du Voisin, sortie sans donnée de réservation", async () => {
  test.setTimeout(90_000);
  expect(slugs.length).toBe(8);
  // 2 nuits, 4 personnes (2 adultes + 2 mineurs).
  const out = probe(id.origin, "2036-06-10", "2036-06-12", 2, 2);

  // Exclus : origine, sans GPS, désactivé, sans domaine.
  expect(out.map((v) => v.slug)).toEqual([`${P}-near`, `${P}-ruled`, `${P}-far`, `${P}-nocap`]);
  const by = Object.fromEntries(out.map((v) => [String(v.slug).replace(`${P}-`, ""), v]));

  // Distances croissantes (0,1° de latitude ≈ 11,1 km).
  const d = out.map((v) => v.distanceKm as number);
  expect([...d].sort((a, b) => a - b)).toEqual(d);
  expect(d[0]).toBeGreaterThan(10.5);
  expect(d[0]).toBeLessThan(11.7);

  // near : 2 chambres de 2 -> loge les 4.
  expect(by.near).toMatchObject({ fitsWholeGroup: true, maxCapacity: 4, city: "Les Épesses", phone: "+33 2 51 00 00 00", photoUrl: "/p/h.jpg", domain: `${P}-near.example.test`, name: "Hôtel near" });
  // ruled : séjour min 3 nuits -> chambre refusée par SES règles, malgré 4 places libres.
  expect(by.ruled).toMatchObject({ fitsWholeGroup: false, maxCapacity: 0, photoUrl: "/p/g.jpg", city: null, phone: null });
  // far : 3 places seulement -> capacité max, pas tout le groupe.
  expect(by.far).toMatchObject({ fitsWholeGroup: false, maxCapacity: 3, photoUrl: null });
  expect(by.nocap).toMatchObject({ fitsWholeGroup: false, maxCapacity: 0 });

  // Même séjour de 3 nuits : la règle du Voisin est respectée, « ruled » loge tout le groupe.
  const three = probe(id.origin, "2036-06-10", "2036-06-13", 2, 2);
  expect(three.find((v) => v.slug === `${P}-ruled`)).toMatchObject({ fitsWholeGroup: true, maxCapacity: 4 });

  // Aucune donnée de réservation ni de voyageur : clés exactes, rien d'autre.
  const allowed = ["city", "distanceKm", "domain", "fitsWholeGroup", "maxCapacity", "name", "phone", "photoUrl", "slug"];
  for (const v of out) expect(Object.keys(v).sort()).toEqual(allowed);
});

test("findVoisins : origine sans GPS ou désactivée, ou inexistante -> aucun Voisin (isolation)", async () => {
  test.setTimeout(90_000);
  expect(probe(id.nogps, "2036-06-10", "2036-06-12", 2, 0)).toEqual([]);
  expect(probe(id.off, "2036-06-10", "2036-06-12", 2, 0)).toEqual([]);
  expect(probe("00000000-0000-4000-8000-000000000000", "2036-06-10", "2036-06-12", 2, 0)).toEqual([]);
  // Entrée invalide (0 adulte) : pas de plantage, réponse « ne loge pas ».
  const none = probe(id.origin, "2036-06-10", "2036-06-12", 0, 3);
  expect(none.every((v) => v.fitsWholeGroup === false)).toBe(true);
});

test("findVoisins n'écrit rien : aucune réservation créée chez les Voisins", async () => {
  test.setTimeout(90_000);
  const count = async () =>
    (await pool.query("SELECT (SELECT count(*) FROM bookings) + (SELECT count(*) FROM dossiers) AS n")).rows[0].n;
  const before = await count();
  probe(id.origin, "2036-07-10", "2036-07-12", 2, 0);
  expect(await count()).toBe(before);
});

test("l'hôtel de démo est hors réseau : ni Voisin, ni origine", async () => {
  test.setTimeout(90_000);
  const demo = { DEMO_TENANT_SLUG: `${P}-near` };
  // « near » désigné démo : il disparaît des Voisins de l'origine.
  expect(probe(id.origin, "2036-06-10", "2036-06-12", 2, 2, demo).map((v) => v.slug)).toEqual([`${P}-ruled`, `${P}-far`, `${P}-nocap`]);
  // Et, comme origine, il n'a aucun Voisin.
  expect(probe(id.near, "2036-06-10", "2036-06-12", 2, 2, demo)).toEqual([]);
  // Sans démo désignée, il est un Voisin comme un autre.
  expect(probe(id.origin, "2036-06-10", "2036-06-12", 2, 2).map((v) => v.slug)).toContain(`${P}-near`);
});
