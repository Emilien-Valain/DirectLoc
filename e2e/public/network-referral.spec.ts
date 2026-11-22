import { Pool } from "pg";
import { test, expect, type Page } from "@playwright/test";
import { fd } from "../helpers/dates";
import { fillGuestContact } from "../helpers/guest";
import { insertDossier } from "../helpers/dossier";
import { startFakeStripe, type FakeStripe } from "../helpers/fake-stripe";

/**
 * Spécification : Tests de non-régression > Public > Réseau des Voisins : complet, Renvoi, attribution.
 *
 * Tenants dédiés (slugs aléatoires par run, zone GPS vide), tous supprimés à la fin avec leurs
 * Renvois, Dossiers et réservations :
 *  - A  : l'hôtel complet (1 chambre de 2) ; B : Voisin proche (2 chambres de 2, ~11 km, nom piégé XSS) ;
 *  - D  : Voisin lointain (~55 km, 2 chambres de 2) ; C : hors réseau (networkEnabled false, tout près).
 */

const S = Math.random().toString(36).slice(2, 8);
const slug = { a: `nra-${S}`, b: `nrb-${S}`, c: `nrc-${S}`, d: `nrd-${S}` };
const site = (k: keyof typeof slug) => `http://${slug[k]}.localhost:3001`;
const T: Record<string, string> = {};
const ROOM: Record<string, string[]> = {};
const ACCOUNT = "acct_test_e2e_network";
const XSS_NAME = "Gîtes <script>alert(1)</script> du Bocage";
const XSS_CITY = "<b>Les</b> Épesses";

const IN = fd("2026-09-14");
const OUT = fd("2026-09-16"); // 2 nuits

/** Date ISO décalée de n jours, et ses formes affichées par le site (fr-FR, UTC). */
const plus = (iso: string, n: number) => new Date(Date.parse(iso + "T00:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);
const long = (iso: string) => new Date(iso + "T00:00:00Z").toLocaleDateString("fr-FR", { day: "numeric", month: "long", timeZone: "UTC" });
/** Valeur affichée par les champs de date : jj/mm/aaaa. */
const dmy = (iso: string) => iso.split("-").reverse().join("/");
const short = (iso: string) => new Date(iso + "T00:00:00Z").toLocaleDateString("fr-FR", { day: "numeric", month: "short", timeZone: "UTC" });

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
let stripe: FakeStripe;

async function makeTenant(key: keyof typeof slug, name: string, config: object, rooms: number[], stripeAccount = true) {
  const { rows } = await pool.query(
    `INSERT INTO tenants (slug, name, domain, config, stripe_account_id) VALUES ($1, $2, $3, $4::jsonb, $5) RETURNING id`,
    [slug[key], name, `${slug[key]}.example.test`, JSON.stringify(config), stripeAccount ? ACCOUNT : null],
  );
  T[key] = rows[0].id;
  const { rows: [prop] } = await pool.query("INSERT INTO properties (tenant_id, name) VALUES ($1, $2) RETURNING id", [T[key], name]);
  ROOM[key] = [];
  for (const [i, cap] of rooms.entries()) {
    const r = await pool.query(
      `INSERT INTO rooms (tenant_id, property_id, name, slug, price_per_night, capacity) VALUES ($1, $2, $3, $4, '90.00', $5) RETURNING id`,
      [T[key], prop.id, `Chambre ${key.toUpperCase()}${i + 1}`, `ch-${i + 1}`, cap],
    );
    ROOM[key].push(r.rows[0].id);
  }
}

async function purge() {
  const ids = Object.values(T);
  if (ids.length === 0) return;
  await pool.query("DELETE FROM referrals WHERE from_tenant_id = ANY($1::uuid[]) OR to_tenant_id = ANY($1::uuid[])", [ids]);
  await pool.query("DELETE FROM payments WHERE tenant_id = ANY($1::uuid[])", [ids]);
  await pool.query("DELETE FROM booking_lines WHERE booking_id IN (SELECT id FROM bookings WHERE tenant_id = ANY($1::uuid[]))", [ids]).catch(() => {});
  await pool.query("DELETE FROM bookings WHERE tenant_id = ANY($1::uuid[])", [ids]);
  await pool.query("DELETE FROM dossiers WHERE tenant_id = ANY($1::uuid[])", [ids]);
}

test.beforeAll(async () => {
  await makeTenant("a", "Hôtel Complet", { latitude: 22, longitude: 22 }, [2], false);
  await makeTenant("b", XSS_NAME, { latitude: 22.1, longitude: 22, city: XSS_CITY }, [2, 2]);
  await makeTenant("c", "Hors Réseau", { latitude: 22.05, longitude: 22, networkEnabled: false }, [2, 2]);
  await makeTenant("d", "Voisin Lointain", { latitude: 22.5, longitude: 22 }, [2, 2]);
  stripe = await startFakeStripe();
});

test.afterAll(async () => {
  await stripe?.close();
  await purge();
  const ids = Object.values(T);
  await pool.query("DELETE FROM rooms WHERE tenant_id = ANY($1::uuid[])", [ids]);
  await pool.query("DELETE FROM properties WHERE tenant_id = ANY($1::uuid[])", [ids]);
  await pool.query("DELETE FROM tenants WHERE id = ANY($1::uuid[])", [ids]);
  await pool.end();
});

test.afterEach(async () => {
  await purge();
  stripe.sessions.length = 0;
});

// Réservation limitée à 5 envois / 10 min par IP, /voisin à 20 / min : une IP par test.
test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders({
    "x-forwarded-for": `10.21.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`,
  });
});

const searchUrl = (host: string, adults: number, minors = 0) =>
  `${host}/?${new URLSearchParams({ checkIn: IN, checkOut: OUT, adults: String(adults), minors: String(minors) })}`;

async function open(page: Page, url: string) {
  await page.goto(url);
  await page.waitForLoadState("networkidle");
}

/** Cherche à la main sur l'accueil (réessaie : l'hydratation peut avaler un premier clic). */
async function searchOnHome(page: Page, host: string, adults: number) {
  await open(page, `${host}/`);
  await expect(async () => {
    await page.fill("#search-checkin", IN);
    await page.fill("#search-checkout", OUT);
    await page.selectOption("#search-adults", String(adults));
    await page.getByRole("button", { name: "Voir les disponibilités" }).click();
    await expect(page.getByTestId("full-slip")).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 20_000 });
}

const referralCount = async () =>
  (await pool.query("SELECT count(*)::int AS n FROM referrals WHERE from_tenant_id = ANY($1::uuid[])", [Object.values(T)])).rows[0].n as number;

/** Va jusqu'au paiement depuis la page de réservation de plusieurs chambres déjà ouverte. */
async function payGroup(page: Page, lastName: string) {
  await fillGuestContact(page, { lastName, email: `${lastName.toLowerCase()}@example.com` });
  await page.getByTestId("booking-submit").click();
  await expect(page).toHaveURL(/\/reserver\/confirmation\?session_id=cs_test_fake_/, { timeout: 20_000 });
  const dossierId = stripe.sessions[stripe.sessions.length - 1].params["metadata[dossierId]"];
  const { rows } = await pool.query("SELECT tenant_id, referred_by_tenant_id FROM dossiers WHERE id = $1", [dossierId]);
  return rows[0] as { tenant_id: string; referred_by_tenant_id: string | null };
}

test.describe("Public — Réseau des Voisins : complet, Renvoi, attribution", () => {
  test("parcours complet : A complet → Voisins (distance, sans prix) → Renvoi → site de B pré-rempli → réservation attribuée à A", async ({ page }) => {
    let dialogs = 0;
    page.on("dialog", (d) => { dialogs++; void d.dismiss(); });

    // 3 personnes : A (une chambre de 2) ne peut pas, B et D oui (2 chambres de 2).
    await searchOnHome(page, site("a"), 3);
    const slip = page.getByTestId("full-slip");
    await expect(slip).toBeVisible();
    await expect(slip.locator(".s-full-title")).toHaveText(`Complet du ${long(IN)} au ${long(OUT)}`);
    await expect(page.getByTestId("full-slots")).toHaveCount(0); // 3 personnes : aucun autre créneau chez A
    const voisins = page.getByTestId("full-voisins").locator("li");
    await expect(voisins).toHaveCount(2); // C (hors réseau) absent
    // Plus proche d'abord, distance toujours affichée, nom et ville échappés, jamais de prix.
    await expect(voisins.nth(0)).toContainText(XSS_NAME);
    await expect(voisins.nth(0)).toContainText(/<b>Les<\/b> Épesses · 11[,.]\d km/);
    await expect(voisins.nth(1)).toContainText("Voisin Lointain");
    await expect(voisins.nth(1)).toContainText(/5\d,\d km/);
    await expect(slip).not.toContainText("€");
    await expect(slip).not.toContainText("Hors Réseau");
    expect(await slip.locator("script, b").count()).toBe(0);
    expect(dialogs).toBe(0);

    // Clic : Renvoi enregistré puis arrivée chez B, recherche pré-remplie, via = A.
    expect(await referralCount()).toBe(0);
    await Promise.all([
      page.waitForURL(new RegExp(`^${site("b").replace(/[.]/g, "\\.")}/\\?`), { timeout: 20_000 }),
      voisins.nth(0).getByRole("link").click(),
    ]);
    const url = new URL(page.url());
    expect(Object.fromEntries(url.searchParams)).toEqual({ checkIn: IN, checkOut: OUT, adults: "3", minors: "0", via: slug.a });
    await page.waitForLoadState("networkidle");
    await expect(page.locator("#search-checkin")).toHaveValue(dmy(IN));
    await expect(page.locator("#search-checkout")).toHaveValue(dmy(OUT));
    await expect(page.locator("#search-adults")).toHaveValue("3");
    // La recherche part toute seule : B loge les 3 sur 2 chambres.
    await expect(page.getByTestId("search-group")).toContainText("2 chambres pour 3 personnes");

    const { rows: refs } = await pool.query("SELECT * FROM referrals WHERE from_tenant_id = $1", [T.a]);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ to_tenant_id: T.b, guest_count: 3, kind: "full", from_dossier_id: null });
    expect(Object.keys(refs[0]).sort()).toEqual(["check_in", "check_out", "created_at", "from_dossier_id", "from_tenant_id", "guest_count", "id", "kind", "share_notified_at", "to_dossier_id", "to_tenant_id"]);

    // Réservation : `via` suit dans l'URL (pas de cookie) jusqu'au Dossier.
    await page.getByTestId("search-group").getByRole("link", { name: /Réserver ces 2 chambres/ }).click();
    await expect(page).toHaveURL(new RegExp(`via=${slug.a}`));
    expect((await page.context().cookies()).filter((c) => /via|referr|voisin/i.test(c.name))).toEqual([]);
    await expect(page.getByTestId("dossier-room")).toHaveCount(2);
    const dossier = await payGroup(page, "Attribue");
    expect(dossier).toEqual({ tenant_id: T.b, referred_by_tenant_id: T.a });
    expect(dialogs).toBe(0);
  });

  test("créneaux proches : A pris sur les dates → jusqu'à 3 créneaux ±7 jours, même durée ; un clic relance la recherche", async ({ page }) => {
    const dossier = await insertDossier(pool, T.a, { checkIn: IN, checkOut: OUT });
    await pool.query(
      `INSERT INTO bookings (tenant_id, dossier_id, room_id, check_in, check_out, total_price, status, guest_name, guest_email, guest_count, source)
       VALUES ($1, $2, $3, $4, $5, '180.00', 'confirmed', 'Pris', 'pris@example.com', 2, 'direct')`,
      [T.a, dossier, ROOM.a[0], IN, OUT],
    );
    await searchOnHome(page, site("a"), 2);
    const slots = page.getByTestId("full-slots").locator("li");
    await expect(slots).toHaveCount(3); // +2 j, −2 j, +3 j (±1 j chevauchent la réservation)
    const labels = await slots.allInnerTexts();
    expect(labels).toEqual([2, -2, 3].map((d) => `Du ${short(plus(IN, d))} au ${short(plus(OUT, d))}`));
    await expect(page.getByTestId("full-voisins").locator("li")).toHaveCount(2); // B et D logent aussi 2 personnes

    await slots.nth(0).getByRole("button").click();
    await expect(page.locator("#search-checkin")).toHaveValue(dmy(plus(IN, 2)));
    await expect(page.locator("a.s-search-room")).toHaveCount(1);
    await expect(page.getByTestId("full-slip")).toHaveCount(0);
  });

  test("rien à proposer : aucun bloc Complet (hôtel hors réseau et sans créneau)", async ({ page }) => {
    // C est hors réseau et n'a pas de place pour 5 ; aucun créneau, aucun Voisin pour lui.
    await open(page, `${site("c")}/`);
    await expect(async () => {
      await page.fill("#search-checkin", IN);
      await page.fill("#search-checkout", OUT);
      await page.selectOption("#search-adults", "5");
      await page.getByRole("button", { name: "Voir les disponibilités" }).click();
      await expect(page.getByTestId("search-no-room")).toBeVisible({ timeout: 3000 });
    }).toPass({ timeout: 20_000 });
    await expect(page.getByTestId("full-slip")).toHaveCount(0);
    const res = await page.request.get(`${site("c")}/api/network/full?from=${IN}&to=${OUT}&adults=5`);
    expect(await res.json()).toEqual({ slots: [], voisins: [], share: null });
  });

  test("via falsifié, inconnu, hors réseau ou de soi-même → réservation normale, non attribuée", async ({ page }) => {
    // Le serveur revérifie chaque `via`, quelle que soit l'URL forgée.
    for (const via of [`forge-${S}`, slug.c, slug.b, "x'; DROP TABLE dossiers;--", `${slug.a}%00`]) {
      await page.setExtraHTTPHeaders({ "x-forwarded-for": `10.22.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}` });
      const q = new URLSearchParams({ checkIn: IN, checkOut: OUT, adults: "3", minors: "0", via });
      await open(page, `${site("b")}/reserver/chambres?${q}`);
      await expect(page.getByTestId("dossier-room")).toHaveCount(2);
      const dossier = await payGroup(page, "Forge");
      expect(dossier, via).toEqual({ tenant_id: T.b, referred_by_tenant_id: null });
      await pool.query("DELETE FROM payments WHERE tenant_id = $1", [T.b]);
      await pool.query("DELETE FROM bookings WHERE tenant_id = $1", [T.b]);
      await pool.query("DELETE FROM dossiers WHERE tenant_id = $1", [T.b]);
    }
  });

  test("réservation d'une seule chambre : `via` valide attribué, `via` d'un hôtel hors réseau ignoré", async ({ page }) => {
    for (const [via, expected] of [[slug.a, () => T.a], [slug.c, () => null]] as const) {
      await page.setExtraHTTPHeaders({ "x-forwarded-for": `10.23.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}` });
      const q = new URLSearchParams({ checkIn: IN, checkOut: OUT, guests: "2", via });
      await open(page, `${site("b")}/reserver/${ROOM.b[0]}?${q}`);
      await fillGuestContact(page, { lastName: "Seule", email: "seule@example.com" });
      await page.getByTestId("booking-submit").click();
      await expect(page).toHaveURL(/\/reserver\/confirmation\?session_id=cs_test_fake_/, { timeout: 20_000 });
      const dossierId = stripe.sessions[stripe.sessions.length - 1].params["metadata[dossierId]"];
      const { rows } = await pool.query("SELECT referred_by_tenant_id FROM dossiers WHERE id = $1", [dossierId]);
      expect(rows[0].referred_by_tenant_id, via).toBe(expected());
      await pool.query("DELETE FROM payments WHERE tenant_id = $1", [T.b]);
      await pool.query("DELETE FROM bookings WHERE tenant_id = $1", [T.b]);
      await pool.query("DELETE FROM dossiers WHERE tenant_id = $1", [T.b]);
    }
  });

  test("/voisin : paramètres invalides, slug inconnu, Voisin hors réseau → 404 (jamais 500), aucun Renvoi", async ({ request }) => {
    const get = (p: string) => request.get(`${site("a")}${p}`, { maxRedirects: 0 });
    const good = `checkIn=${IN}&checkOut=${OUT}&adults=2&minors=0`;
    const cases: [string, string][] = [
      ["slug inconnu", `/voisin/nexiste-pas-${S}?${good}`],
      ["Voisin hors réseau", `/voisin/${slug.c}?${good}`],
      ["soi-même", `/voisin/${slug.a}?${good}`],
      ["slug piégé", `/voisin/%3Cscript%3E?${good}`],
      ["dates absentes", `/voisin/${slug.b}`],
      ["checkOut avant checkIn", `/voisin/${slug.b}?checkIn=${OUT}&checkOut=${IN}&adults=2`],
      ["date inexistante", `/voisin/${slug.b}?checkIn=2030-02-31&checkOut=2030-03-02&adults=2`],
      ["date passée", `/voisin/${slug.b}?checkIn=2020-01-01&checkOut=2020-01-03&adults=2`],
      ["dates en lettres", `/voisin/${slug.b}?checkIn=abc&checkOut=def&adults=2`],
      ["adultes à 0", `/voisin/${slug.b}?checkIn=${IN}&checkOut=${OUT}&adults=0`],
      ["adultes en lettres", `/voisin/${slug.b}?checkIn=${IN}&checkOut=${OUT}&adults=abc`],
      ["groupe énorme", `/voisin/${slug.b}?checkIn=${IN}&checkOut=${OUT}&adults=999`],
      ["séjour interminable", `/voisin/${slug.b}?checkIn=${IN}&checkOut=2099-01-01&adults=2`],
    ];
    for (const [name, p] of cases) expect((await get(p)).status(), name).toBe(404);
    expect(await referralCount()).toBe(0);
  });

  test("/voisin valide : 302 vers le domaine du Voisin avec dates, personnes et via ; un Renvoi par clic ; origine hors réseau → 404", async ({ request }) => {
    const res = await request.get(`${site("a")}/voisin/${slug.b}?checkIn=${IN}&checkOut=${OUT}&adults=2&minors=1`, { maxRedirects: 0 });
    expect(res.status()).toBe(302);
    const loc = new URL(res.headers()["location"]);
    expect(loc.origin).toBe(site("b"));
    expect(Object.fromEntries(loc.searchParams)).toEqual({ checkIn: IN, checkOut: OUT, adults: "2", minors: "1", via: slug.a });
    await request.get(`${site("a")}/voisin/${slug.d}?checkIn=${IN}&checkOut=${OUT}&adults=2`, { maxRedirects: 0 });
    const { rows } = await pool.query("SELECT to_tenant_id, guest_count FROM referrals WHERE from_tenant_id = $1 ORDER BY created_at", [T.a]);
    expect(rows).toEqual([{ to_tenant_id: T.b, guest_count: 3 }, { to_tenant_id: T.d, guest_count: 2 }]);

    // Isolation : l'hôtel C est hors réseau, il ne peut renvoyer personne ni recevoir de Renvoi.
    const before = await referralCount();
    const fromC = await request.get(`${site("c")}/voisin/${slug.b}?checkIn=${IN}&checkOut=${OUT}&adults=2`, { maxRedirects: 0 });
    expect(fromC.status()).toBe(404);
    expect(await referralCount()).toBe(before);
  });

  test("/api/network/full : paramètres invalides → 400, jamais 500 ; réponse limitée à des faits publics", async ({ request }) => {
    for (const q of ["", "from=abc&to=def&adults=2", `from=${OUT}&to=${IN}&adults=2`, `from=${IN}&to=${OUT}&adults=0`, `from=${IN}&to=${OUT}&adults=x`, `from=${IN}&to=${OUT}&adults=2&minors=-1`]) {
      expect((await request.get(`${site("a")}/api/network/full?${q}`)).status(), q).toBe(400);
    }
    const ok = await request.get(`${site("a")}/api/network/full?from=${IN}&to=${OUT}&adults=3`);
    expect(ok.status()).toBe(200);
    const body = await ok.json();
    expect(body.voisins).toHaveLength(2);
    for (const v of body.voisins) expect(Object.keys(v).sort()).toEqual(["city", "distanceKm", "name", "slug"]);
    expect(JSON.stringify(body)).not.toContain(slug.c);
  });
});
