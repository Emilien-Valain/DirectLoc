import { Pool } from "pg";
import { test, expect, type Page } from "@playwright/test";
import { fd } from "../helpers/dates";
import { fillGuestContact } from "../helpers/guest";
import { insertDossier } from "../helpers/dossier";
import { startFakeStripe, type FakeStripe } from "../helpers/fake-stripe";

/**
 * Spécification : Tests de non-régression > Public > Réseau des Voisins : partage d'un groupe.
 *
 * Tenants dédiés (slugs aléatoires par run, zone GPS vide), tous supprimés à la fin avec leurs
 * Renvois, Dossiers et réservations :
 *  - A : l'hôtel (chambres de 2 et 3 = 5 places, téléphone) ; B : Voisin proche (1 chambre de 4,
 *    ~11 km, nom piégé XSS) ; D : Voisin lointain (1 chambre de 4, ~55 km) ; C : hors réseau (1 chambre de 4).
 *  - Groupe de 9 : A en loge 5, B ou D les 4 autres.
 */

const S = Math.random().toString(36).slice(2, 8);
const slug = { a: `nsa-${S}`, b: `nsb-${S}`, c: `nsc-${S}`, d: `nsd-${S}` };
const site = (k: keyof typeof slug) => `http://${slug[k]}.localhost:3001`;
const T: Record<string, string> = {};
const ROOM: Record<string, string[]> = {};
const ACCOUNT = "acct_test_e2e_network_share";
const XSS_NAME = "Gîtes <script>alert(1)</script> du Bocage";
const XSS_CITY = "<b>Les</b> Épesses";
const PHONE = "+33 2 40 00 00 01";

const IN = fd("2026-09-14");
const OUT = fd("2026-09-16");

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
  await makeTenant("a", "Hôtel Complet", { latitude: 24, longitude: 24, phone: PHONE }, [2, 3]);
  await makeTenant("b", XSS_NAME, { latitude: 24.1, longitude: 24, city: XSS_CITY }, [4]);
  await makeTenant("c", "Hors Réseau", { latitude: 24.05, longitude: 24, networkEnabled: false }, [4]);
  await makeTenant("d", "Voisin Lointain", { latitude: 24.5, longitude: 24 }, [4]);
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
    "x-forwarded-for": `10.31.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`,
  });
});

async function open(page: Page, url: string) {
  await page.goto(url);
  await page.waitForLoadState("networkidle");
}

/** Cherche à la main sur l'accueil de l'hôte (réessaie : l'hydratation peut avaler un premier clic). */
async function searchOnHome(page: Page, host: string, adults: number, expectedTestId: string) {
  await open(page, `${host}/`);
  await expect(async () => {
    await page.fill("#search-checkin", IN);
    await page.fill("#search-checkout", OUT);
    await page.selectOption("#search-adults", String(adults));
    await page.getByRole("button", { name: "Voir les disponibilités" }).click();
    await expect(page.getByTestId(expectedTestId)).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 20_000 });
}

const referrals = async () =>
  (await pool.query("SELECT to_tenant_id, guest_count, kind FROM referrals WHERE from_tenant_id = ANY($1::uuid[]) ORDER BY created_at", [Object.values(T)])).rows as {
    to_tenant_id: string;
    guest_count: number;
    kind: string;
  }[];

/** Un Voisin se remplit entre-temps : sa chambre est prise sur les dates. */
async function fillUp(key: keyof typeof slug) {
  const dossier = await insertDossier(pool, T[key], { checkIn: IN, checkOut: OUT });
  await pool.query(
    `INSERT INTO bookings (tenant_id, dossier_id, room_id, check_in, check_out, total_price, status, guest_name, guest_email, guest_count, source)
     VALUES ($1, $2, $3, $4, $5, '180.00', 'confirmed', 'Pris', 'pris@example.com', 4, 'direct')`,
    [T[key], dossier, ROOM[key][0], IN, OUT],
  );
}

/** Réserve la part de l'hôte (5 personnes, 2 chambres) avec un paramètre `share` donné ; renvoie l'URL de confirmation. */
async function bookHostPart(page: Page, share: string) {
  const q = new URLSearchParams({ checkIn: IN, checkOut: OUT, adults: "5", minors: "0", share });
  await open(page, `${site("a")}/reserver/chambres?${q}`);
  await expect(page.getByTestId("dossier-room")).toHaveCount(2);
  await fillGuestContact(page, { lastName: "Partage", email: "partage@example.com" });
  await page.getByTestId("booking-submit").click();
  await expect(page).toHaveURL(/\/reserver\/confirmation\?session_id=cs_test_fake_/, { timeout: 20_000 });
  return page.url();
}

test.describe("Public — Réseau des Voisins : partage d'un groupe", () => {
  test("9 personnes, l'hôte en loge 5, le Voisin 4 → partage proposé → confirmation propose le Voisin (4 personnes) → Renvoi shared", async ({ page }) => {
    let dialogs = 0;
    page.on("dialog", (d) => { dialogs++; void d.dismiss(); });

    await searchOnHome(page, site("a"), 9, "full-slip");
    const slip = page.getByTestId("full-slip");
    await expect(page.getByTestId("full-voisins")).toHaveCount(0); // personne ne loge les 9
    await expect(page.getByTestId("full-slots")).toHaveCount(0);
    await expect(page.getByTestId("full-share")).toContainText(/^Nous logeons 5 personnes ici, /);
    await expect(page.getByTestId("full-share")).toContainText(XSS_NAME);
    await expect(page.getByTestId("full-share")).toContainText(/peut loger les 4 autres\.$/);
    await expect(page.getByTestId("full-share")).toContainText(/11[,.]\d km/);
    await expect(page.getByTestId("full-share-mention")).toHaveText(/^Votre groupe sera réparti sur 2 hébergements à 11[,.]\d km, avec 2 réservations et 2 paiements séparés\.$/);
    await expect(slip).not.toContainText("€");
    await expect(slip).not.toContainText("Hors Réseau");
    expect(await slip.locator("script, b").count()).toBe(0);

    // La part de l'hôte d'abord : parcours Dossier normal, 5 personnes, `share` dans l'URL (pas de cookie).
    await page.getByTestId("full-share-go").click();
    await expect(page).toHaveURL(new RegExp(`adults=5.*share=${slug.b}%3A4%3A0`));
    await expect(page.getByTestId("search-group")).toContainText("2 chambres pour 5 personnes");
    await page.getByTestId("search-group").getByRole("link", { name: /Réserver ces 2 chambres/ }).click();
    await expect(page).toHaveURL(new RegExp(`share=${slug.b}%3A4%3A0`));
    await expect(page.getByTestId("dossier-room")).toHaveCount(2);
    await fillGuestContact(page, { lastName: "Partage", email: "partage@example.com" });
    await page.getByTestId("booking-submit").click();
    await expect(page).toHaveURL(/\/reserver\/confirmation\?session_id=cs_test_fake_.*share=/, { timeout: 20_000 });
    expect((await page.context().cookies()).filter((c) => /share|via|referr|voisin/i.test(c.name))).toEqual([]);
    const dossierId = stripe.sessions[stripe.sessions.length - 1].params["metadata[dossierId]"];
    const { rows: [dossier] } = await pool.query("SELECT tenant_id, referred_by_tenant_id FROM dossiers WHERE id = $1", [dossierId]);
    expect(dossier).toEqual({ tenant_id: T.a, referred_by_tenant_id: null });

    // Confirmation : le Voisin est revérifié et proposé avec 4 personnes, nom échappé.
    const follow = page.getByTestId("share-followup");
    await expect(follow).toContainText("Et le reste de votre groupe ?");
    await expect(follow).toContainText(XSS_NAME);
    await expect(follow).toContainText("les 4 autres personnes");
    await expect(follow).toContainText("2 réservations et 2 paiements séparés");
    await expect(follow).not.toContainText("Un autre hébergement voisin");
    expect(await follow.locator("script, b").count()).toBe(0);
    const href = new URL((await page.getByTestId("share-voisin-link").getAttribute("href"))!, site("a"));
    expect(href.pathname).toBe(`/voisin/${slug.b}`);
    // `dossier` = le Dossier de A, relu par /voisin sur ce même site pour relier les deux Dossiers (issue 04).
    expect(Object.fromEntries(href.searchParams)).toEqual({ checkIn: IN, checkOut: OUT, adults: "4", minors: "0", kind: "shared", dossier: dossierId });
    expect(await referrals()).toEqual([]);

    // Clic : Renvoi `shared` (4 personnes), arrivée chez B avec la recherche pré-remplie et via = A.
    await Promise.all([
      page.waitForURL(new RegExp(`^${site("b").replace(/[.]/g, "\\.")}/\\?`), { timeout: 20_000 }),
      page.getByTestId("share-voisin-link").click(),
    ]);
    expect(Object.fromEntries(new URL(page.url()).searchParams)).toEqual({ checkIn: IN, checkOut: OUT, adults: "4", minors: "0", via: slug.a });
    await page.waitForLoadState("networkidle");
    await expect(page.locator("#search-adults")).toHaveValue("4");
    await expect(page.locator("a.s-search-room")).toHaveCount(1); // la chambre de 4 de B
    expect(await referrals()).toEqual([{ to_tenant_id: T.b, guest_count: 4, kind: "shared" }]);
    const { rows: [link] } = await pool.query("SELECT from_dossier_id, to_dossier_id FROM referrals WHERE from_tenant_id = $1", [T.a]);
    expect(link).toEqual({ from_dossier_id: dossierId, to_dossier_id: null });
    expect(dialogs).toBe(0);
  });

  test("Voisin rempli entre-temps → un autre Voisin, puis plus aucun → téléphone de l'hôte", async ({ page }) => {
    const url = await bookHostPart(page, `${slug.b}:4:0`);
    await expect(page.getByTestId("share-voisin-link")).toHaveAttribute("href", new RegExp(`^/voisin/${slug.b}\\?`));

    await fillUp("b");
    await open(page, url);
    await expect(page.getByTestId("share-followup")).toContainText("Un autre hébergement voisin");
    await expect(page.getByTestId("share-followup")).toContainText("Voisin Lointain");
    await expect(page.getByTestId("share-voisin-link")).toHaveAttribute("href", new RegExp(`^/voisin/${slug.d}\\?.*kind=shared`));

    await fillUp("d");
    await open(page, url);
    await expect(page.getByTestId("share-voisin-link")).toHaveCount(0);
    const phone = page.getByTestId("share-phone");
    await expect(phone).toContainText("les 4 autres personnes");
    await expect(phone.getByRole("link", { name: PHONE })).toHaveAttribute("href", `tel:${PHONE}`);
  });

  test("aucun Voisin ne loge le reste (11 personnes : 5 + 6 > 4) → aucune proposition de partage", async ({ page, request }) => {
    const res = await request.get(`${site("a")}/api/network/full?from=${IN}&to=${OUT}&adults=11`);
    expect(await res.json()).toEqual({ slots: [], voisins: [], share: null });
    await open(page, `${site("a")}/`);
    await expect(async () => {
      await page.fill("#search-checkin", IN);
      await page.fill("#search-checkout", OUT);
      await page.selectOption("#search-adults", "11");
      await page.getByRole("button", { name: "Voir les disponibilités" }).click();
      await expect(page.getByTestId("search-no-room")).toBeVisible({ timeout: 3000 });
    }).toPass({ timeout: 20_000 });
    await expect(page.getByTestId("full-slip")).toHaveCount(0);

    // Les deux Voisins sont pleins : même 9 personnes n'ont plus de partage possible.
    await fillUp("b");
    await fillUp("d");
    const nine = await request.get(`${site("a")}/api/network/full?from=${IN}&to=${OUT}&adults=9`);
    expect((await nine.json()).share).toBeNull();
  });

  test("/api/network/full : proposition de partage = faits publics, un seul Voisin, jamais l'hôtel hors réseau", async ({ request }) => {
    const res = await request.get(`${site("a")}/api/network/full?from=${IN}&to=${OUT}&adults=7&minors=2`);
    const body = await res.json();
    expect(body.voisins).toEqual([]);
    expect(Object.keys(body.share).sort()).toEqual(["host", "rest", "voisin"]);
    expect(Object.keys(body.share.voisin).sort()).toEqual(["city", "distanceKm", "name", "slug"]);
    expect(body.share.voisin.slug).toBe(slug.b);
    // 9 personnes = 5 chez l'hôte + 4 chez le Voisin, au moins 1 adulte de chaque côté.
    const sum = (p: { adults: number; minors: number }) => p.adults + p.minors;
    expect([sum(body.share.host), sum(body.share.rest)]).toEqual([5, 4]);
    expect(body.share.host.adults + body.share.rest.adults).toBe(7);
    expect(body.share.host.minors + body.share.rest.minors).toBe(2);
    expect(body.share.host.adults).toBeGreaterThanOrEqual(1);
    expect(body.share.rest.adults).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(body)).not.toContain(slug.c);

    // Isolation : C est hors réseau, il n'a ni Voisin ni partage ; A ne se voit jamais en partage.
    const fromC = await request.get(`${site("c")}/api/network/full?from=${IN}&to=${OUT}&adults=9`);
    expect(await fromC.json()).toEqual({ slots: [], voisins: [], share: null });
  });

  test("confirmation : paramètres share falsifiés → jamais de 500, rien d'inventé ; Voisin hors réseau ignoré", async ({ page }) => {
    let dialogs = 0;
    page.on("dialog", (d) => { dialogs++; void d.dismiss(); });
    const url = await bookHostPart(page, `${slug.b}:4:0`);
    const sessionId = new URL(url).searchParams.get("session_id")!;
    const conf = (share?: string) => `${site("a")}/reserver/confirmation?session_id=${sessionId}${share === undefined ? "" : `&share=${encodeURIComponent(share)}`}`;

    // Invalides : la page s'affiche (200), sans bloc de partage.
    for (const bad of ["", "garbage", "a:0:2", "a:1:-1", "a:99:99", "A:1:1", "<script>alert(1)</script>:1:1", "../../etc:1:1", `${slug.b}:4:0:9`, `${slug.b}:abc:0`, "x".repeat(5000)]) {
      const res = await page.request.get(conf(bad));
      expect(res.status(), bad.slice(0, 40)).toBe(200);
      expect(await res.text(), bad.slice(0, 40)).not.toContain("share-followup");
    }
    // Sans share du tout : confirmation normale.
    const plain = await page.request.get(conf());
    expect(plain.status()).toBe(200);
    expect(await plain.text()).not.toContain("share-followup");

    // Voisin inconnu ou hors réseau : on ne le propose jamais, le Voisin le plus proche prend le relais.
    for (const other of [slug.c, `inconnu-${S}`, slug.a]) {
      await open(page, conf(`${other}:4:0`));
      await expect(page.getByTestId("share-voisin-link"), other).toHaveAttribute("href", new RegExp(`^/voisin/${slug.b}\\?`));
      await expect(page.getByTestId("share-followup")).toContainText("Un autre hébergement voisin");
    }
    // Groupe énorme (dans les bornes de forme) : aucun Voisin ne le loge → téléphone, pas d'erreur.
    await open(page, conf(`${slug.b}:30:20`));
    await expect(page.getByTestId("share-phone")).toBeVisible();
    expect(dialogs).toBe(0);
    expect(await referrals()).toEqual([]);
  });

  test("isolation : la confirmation d'un autre hôtel ne s'ouvre pas, et /voisin kind=shared est borné", async ({ page, request }) => {
    const url = await bookHostPart(page, `${slug.b}:4:0`);
    const sessionId = new URL(url).searchParams.get("session_id")!;
    // La session de A n'existe pas pour B (même avec share) : 404.
    const other = await request.get(`${site("b")}/reserver/confirmation?session_id=${sessionId}&share=${slug.a}%3A4%3A0`);
    expect(other.status()).toBe(404);

    const good = `checkIn=${IN}&checkOut=${OUT}&adults=4&minors=0`;
    // `request` n'hérite pas des en-têtes de la page : sa propre IP, pour la limite de 20 / min.
    const headers = { "x-forwarded-for": `10.32.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}` };
    const get = (origin: keyof typeof slug, p: string) => request.get(`${site(origin)}${p}`, { maxRedirects: 0, headers });
    for (const [name, origin, p] of [
      ["kind inconnu", "a", `/voisin/${slug.b}?${good}&kind=evil`],
      ["kind en majuscules", "a", `/voisin/${slug.b}?${good}&kind=SHARED`],
      ["kind vide", "a", `/voisin/${slug.b}?${good}&kind=`],
      ["kind shared, Voisin hors réseau", "a", `/voisin/${slug.c}?${good}&kind=shared`],
      ["kind shared, origine hors réseau", "c", `/voisin/${slug.b}?${good}&kind=shared`],
      ["kind shared, soi-même", "a", `/voisin/${slug.a}?${good}&kind=shared`],
      ["kind shared, groupe énorme", "a", `/voisin/${slug.b}?checkIn=${IN}&checkOut=${OUT}&adults=999&kind=shared`],
      ["kind shared, dates passées", "a", `/voisin/${slug.b}?checkIn=2020-01-01&checkOut=2020-01-03&adults=2&kind=shared`],
      ["kind shared, slug piégé", "a", `/voisin/%3Cscript%3E?${good}&kind=shared`],
    ] as const) {
      expect((await get(origin, p)).status(), name).toBe(404);
    }
    expect(await referrals()).toEqual([]);

    // Valide : 302 chez le Voisin, Renvoi shared enregistré ; kind absent reste `full`.
    const ok = await get("a", `/voisin/${slug.b}?${good}&kind=shared`);
    expect(ok.status()).toBe(302);
    expect(new URL(ok.headers()["location"]).origin).toBe(site("b"));
    expect((await get("a", `/voisin/${slug.d}?${good}`)).status()).toBe(302);
    expect(await referrals()).toEqual([
      { to_tenant_id: T.b, guest_count: 4, kind: "shared" },
      { to_tenant_id: T.d, guest_count: 4, kind: "full" },
    ]);
  });
});
