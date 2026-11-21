import fs from "fs";
import path from "path";
import crypto from "crypto";
import { Pool } from "pg";
import { test, expect, type Page } from "@playwright/test";
import { fd } from "../helpers/dates";
import { fillGuestContact } from "../helpers/guest";
import { insertDossier } from "../helpers/dossier";
import { startFakeStripe, type FakeStripe } from "../helpers/fake-stripe";

/**
 * Spécification : Tests de non-régression > Public > Réserver plusieurs chambres (Dossier, ADR-0012).
 *
 * Tenant dédié `dossier-tenant` (id fixe : le proxy garde le tenant 5 min en cache par host),
 * cinq chambres à lui, supprimé à la fin : aucune autre spec ne touche ses chambres.
 * Stripe : faux serveur local (e2e/helpers/fake-stripe.ts) qui garde chaque session créée.
 */

const TENANT_ID = "d0551e00-0000-4000-8000-0000000000d3";
const SLUG = "dossier-tenant";
const SITE = `http://${SLUG}.localhost:3001`;
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? "whsec_test_XXXX";

const ctx = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "e2e", ".auth", "test-context.json"), "utf-8"),
) as { rivalRoomId: string };

// Grange 4 (100 €), Fournil 3 (80 €), Étable 3 (90 €), Lavoir 2 (60 €), Pigeonnier 2 (70 €) — 14 places.
const ROOMS = [
  { key: "grange", name: "La Grange", capacity: 4, price: 100 },
  { key: "fournil", name: "Le Fournil", capacity: 3, price: 80 },
  { key: "etable", name: "L'Étable", capacity: 3, price: 90 },
  { key: "lavoir", name: "Le Lavoir", capacity: 2, price: 60 },
  { key: "pigeonnier", name: "Le Pigeonnier", capacity: 2, price: 70 },
] as const;
type Key = (typeof ROOMS)[number]["key"];
const id: Record<Key, string> = {} as Record<Key, string>;

const CHECK_IN = fd("2026-08-10");
const CHECK_OUT = fd("2026-08-12"); // 2 nuits

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
let stripe: FakeStripe;

async function purgeData() {
  await pool.query("DELETE FROM payments WHERE tenant_id = $1", [TENANT_ID]);
  await pool.query("DELETE FROM bookings WHERE tenant_id = $1", [TENANT_ID]);
  await pool.query("DELETE FROM dossiers WHERE tenant_id = $1", [TENANT_ID]);
}

async function purgeAll() {
  await purgeData();
  for (const t of ["extras", "fees", "booking_rules", "pricing_rules", "manual_blocks"]) {
    await pool.query(`DELETE FROM ${t} WHERE tenant_id = $1`, [TENANT_ID]).catch(() => {});
  }
  await pool.query("DELETE FROM rooms WHERE tenant_id = $1", [TENANT_ID]);
  await pool.query("DELETE FROM properties WHERE tenant_id = $1", [TENANT_ID]);
  await pool.query("DELETE FROM tenants WHERE id = $1", [TENANT_ID]);
}

test.beforeAll(async () => {
  await purgeAll();
  await pool.query(
    `INSERT INTO tenants (id, name, slug, config) VALUES ($1, 'Gîtes du Bocage', $2, $3::jsonb)`,
    [TENANT_ID, SLUG, JSON.stringify({ touristTax: { mode: "fixed", amount: 1.5 } })],
  );
  const { rows: [prop] } = await pool.query(
    "INSERT INTO properties (tenant_id, name) VALUES ($1, 'Gîtes du Bocage') RETURNING id",
    [TENANT_ID],
  );
  for (const r of ROOMS) {
    const { rows } = await pool.query(
      `INSERT INTO rooms (tenant_id, property_id, name, slug, price_per_night, capacity, email_message)
       VALUES ($1, $2, $3, $4, $5, $6, 'Code boîte à clés 4242') RETURNING id`,
      [TENANT_ID, prop.id, r.name, `dossier-${r.key}`, r.price.toFixed(2), r.capacity],
    );
    id[r.key] = rows[0].id;
  }
  await pool.query(
    `INSERT INTO extras (tenant_id, label, price, unit) VALUES ($1, 'Petit-déjeuner', '9.00', 'per_guest_night')`,
    [TENANT_ID],
  );
  // Réservée à la Grange (ADR-0010, amendement « certaines chambres »).
  await pool.query(
    `INSERT INTO extras (tenant_id, label, price, unit, room_ids) VALUES ($1, 'Bain nordique', '30.00', 'per_stay', $2)`,
    [TENANT_ID, [id.grange]],
  );
  await pool.query(`INSERT INTO fees (tenant_id, label, price, unit) VALUES ($1, 'Ménage', '20.00', 'per_stay')`, [TENANT_ID]);
  stripe = await startFakeStripe();
});

test.afterAll(async () => {
  await stripe?.close();
  await purgeAll();
  await pool.end();
});

test.afterEach(async () => {
  await purgeData();
  stripe.sessions.length = 0;
});

// Le formulaire est limité à 5 envois / 10 min par IP : une IP par test.
test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders({
    "x-forwarded-for": `10.13.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`,
  });
});

const groupUrl = (adults: number, minors: number, rooms?: Key[]) => {
  const q = new URLSearchParams({ checkIn: CHECK_IN, checkOut: CHECK_OUT, adults: String(adults), minors: String(minors) });
  if (rooms) q.set("rooms", rooms.map((k) => id[k]).join(","));
  return `${SITE}/reserver/chambres?${q}`;
};

const roomCard = (page: Page, key: Key) => page.locator(`[data-testid="dossier-room"][data-room-id="${id[key]}"]`);
const shownRooms = async (page: Page) =>
  (await page.getByTestId("dossier-room").evaluateAll((els) => els.map((e) => e.getAttribute("data-room-id")))).sort();
const keysOf = (...keys: Key[]) => keys.map((k) => id[k]).sort();

/** Ouvre la page puis attend l'hydratation (une saisie faite avant serait perdue). */
async function open(page: Page, url: string) {
  const res = await page.goto(url);
  await page.waitForLoadState("networkidle");
  return res;
}

/** Soumet le formulaire avec un `plan` forgé (contourne l'interface, comme un client malveillant). */
async function submitForgedPlan(page: Page, plan: unknown, extra: Record<string, string> = {}) {
  await page.evaluate(
    ({ plan, extra }) => {
      const form = document.querySelector("form.s-dossier") as HTMLFormElement;
      (form.querySelector('input[name="plan"]') as HTMLInputElement).value = JSON.stringify(plan);
      for (const [k, v] of Object.entries(extra)) {
        const i = document.createElement("input");
        i.type = "hidden";
        i.name = k;
        i.value = v;
        form.appendChild(i);
      }
      form.requestSubmit();
    },
    { plan, extra },
  );
}

async function countDossiers(email: string) {
  const { rows } = await pool.query(
    "SELECT (SELECT count(*) FROM dossiers WHERE tenant_id = $1 AND guest_email = $2)::int AS d, (SELECT count(*) FROM bookings WHERE tenant_id = $1 AND guest_email = $2)::int AS b",
    [TENANT_ID, email],
  );
  return rows[0] as { d: number; b: number };
}

function sign(payload: string) {
  const t = Math.floor(Date.now() / 1000);
  return `t=${t},v1=${crypto.createHmac("sha256", WEBHOOK_SECRET).update(`${t}.${payload}`).digest("hex")}`;
}

test.describe("Public — réserver plusieurs chambres", () => {
  test("accueil : 9 personnes → 3 chambres proposées (moins de chambres, puis moins cher), lien vers la réservation", async ({ page }) => {
    await open(page, `${SITE}/`);
    await expect(async () => {
      await page.fill("#search-checkin", CHECK_IN);
      await page.fill("#search-checkout", CHECK_OUT);
      await page.selectOption("#search-adults", "7");
      await page.selectOption("#search-minors", "2");
      await page.getByRole("button", { name: "Voir les disponibilités" }).click();
      await expect(page.getByTestId("search-group")).toBeVisible({ timeout: 3000 });
    }).toPass({ timeout: 20_000 });
    const group = page.getByTestId("search-group");
    await expect(group).toContainText("3 chambres pour 9 personnes");
    // 4 + 3 + 2 au moins cher : Grange + Fournil + Lavoir (240 €/nuit).
    await expect(group).toContainText("La Grange");
    await expect(group).toContainText("Le Fournil");
    await expect(group).toContainText("Le Lavoir");
    await expect(group).toContainText("480");
    await expect(group).not.toContainText("Code boîte à clés");
    await group.getByRole("link", { name: "Réserver ces 3 chambres" }).click();
    await expect(page).toHaveURL(/\/reserver\/chambres\?/);
    await expect(page.getByTestId("dossier-room")).toHaveCount(3);
    expect(await shownRooms(page)).toEqual(keysOf("grange", "fournil", "lavoir"));
    await expect(page.getByTestId("dossier-placed")).toContainText("9 voyageurs placés sur 9");
  });

  test("accueil : une chambre suffit → parcours d'une chambre inchangé, plus un lien « plusieurs chambres »", async ({ page }) => {
    await open(page, `${SITE}/`);
    await expect(async () => {
      await page.fill("#search-checkin", CHECK_IN);
      await page.fill("#search-checkout", CHECK_OUT);
      await page.selectOption("#search-adults", "2");
      await page.selectOption("#search-minors", "1");
      await page.getByRole("button", { name: "Voir les disponibilités" }).click();
      await expect(page.locator(".s-search-room").first()).toBeVisible({ timeout: 3000 });
    }).toPass({ timeout: 20_000 });
    // Chambres de 3 places et plus : Grange, Fournil, Étable ; lien direct pré-rempli (enfants compris).
    await expect(page.locator("a.s-search-room")).toHaveCount(3);
    await expect(page.locator("a.s-search-room", { hasText: "La Grange" })).toHaveAttribute(
      "href",
      `/reserver/${id.grange}?checkIn=${CHECK_IN}&checkOut=${CHECK_OUT}&guests=3&children=1`,
    );
    await page.getByTestId("search-several-rooms").click();
    await expect(page).toHaveURL(/\/reserver\/chambres\?/);
    await expect(page.getByTestId("dossier-room")).toHaveCount(1);
  });

  test("accueil : capacité insuffisante (15 personnes pour 14 places) et pas assez d'adultes → message clair", async ({ page }) => {
    await open(page, `${SITE}/`);
    const search = async (adults: string, minors: string) => {
      await page.fill("#search-checkin", CHECK_IN);
      await page.fill("#search-checkout", CHECK_OUT);
      await page.selectOption("#search-adults", adults);
      await page.selectOption("#search-minors", minors);
      await page.getByRole("button", { name: "Voir les disponibilités" }).click();
    };
    await expect(async () => {
      await search("13", "2");
      await expect(page.getByTestId("search-no-room")).toContainText("Pas assez de place pour 15 personnes", { timeout: 3000 });
    }).toPass({ timeout: 20_000 });
    await expect(page.getByTestId("search-no-room")).toContainText("14 personnes au plus");

    // 9 personnes = 3 chambres au moins, mais 2 adultes seulement : chaque chambre veut un adulte.
    await search("2", "7");
    await expect(page.getByTestId("search-no-room")).toContainText("au moins un adulte");
    await expect(page.getByTestId("search-group")).toHaveCount(0);
  });

  test("3 chambres pour 9 personnes : options par chambre, un seul paiement, montants falsifiés ignorés, XSS échappé, 3 réservations confirmées", async ({ page, request }) => {
    const dialogs: string[] = [];
    page.on("dialog", (d) => {
      dialogs.push(d.message());
      void d.dismiss();
    });
    await open(page, groupUrl(7, 2));
    expect(await shownRooms(page)).toEqual(keysOf("grange", "fournil", "lavoir"));
    // Le voyageur ne voit jamais le mot Dossier.
    expect(await page.locator("main, body").first().innerText()).not.toMatch(/dossier/i);

    // Options : petit-déjeuner dans la Grange, puis « Appliquer à toutes les chambres ».
    const grange = roomCard(page, "grange");
    await grange.getByLabel(/Petit-déjeuner/).check();
    await expect(grange.getByLabel(/Bain nordique/)).toBeVisible();
    await expect(roomCard(page, "fournil").getByText("Bain nordique")).toHaveCount(0); // réservée à la Grange
    await grange.getByRole("button", { name: "Appliquer ces options à toutes les chambres" }).click();
    await expect(roomCard(page, "fournil").getByLabel(/Petit-déjeuner/)).toBeChecked();
    await expect(roomCard(page, "lavoir").getByLabel(/Petit-déjeuner/)).toBeChecked();

    // Grange 4 ad. : 200 + 20 + 1,5×4×2 + 9×4×2 = 304 ; Fournil 2 ad. 1 enf. : 160 + 20 + 6 + 54 = 240 ;
    // Lavoir 1 ad. 1 enf. : 120 + 20 + 3 + 36 = 179 → 723 €.
    await expect(page.getByTestId("booking-summary-total")).toHaveText(/723\s€/);
    await expect(page.getByTestId("dossier-summary-room")).toHaveCount(3);

    const xss = "<script>alert(1)</script>";
    await fillGuestContact(page, { firstName: "Hélène", lastName: xss, email: "groupe.bocage@example.com" });
    // Montants falsifiés : champs inventés et prix glissés dans le plan, tous ignorés par le serveur.
    const forged = JSON.parse(await page.locator('input[name="plan"]').inputValue()) as Record<string, unknown>[];
    await submitForgedPlan(
      page,
      forged.map((r) => ({ ...r, totalPrice: 1, price: 0.01, total: 1 })),
      { totalPrice: "1", amount: "1", total: "0.5" },
    );

    await expect(page).toHaveURL(/\/reserver\/confirmation\?session_id=cs_test_fake_/, { timeout: 15_000 });
    expect(stripe.sessions).toHaveLength(1);
    const session = stripe.sessions[0];
    const items = stripe.lineItems(session);
    const cents = items.reduce((s, i) => s + i.unitAmount * i.quantity, 0);
    expect(cents).toBe(72300);
    // Une ligne d'hébergement par chambre, et chaque option / frais / taxe préfixé par sa chambre.
    expect(items.filter((i) => / — 2 nuits$/.test(i.name)).map((i) => i.unitAmount).sort()).toEqual([12000, 16000, 20000]);
    expect(items.filter((i) => i.name.endsWith("· Petit-déjeuner"))).toHaveLength(3);
    expect(items.find((i) => i.name === "La Grange · Petit-déjeuner")).toMatchObject({ unitAmount: 900, quantity: 8 });
    expect(items.filter((i) => i.name.endsWith("· Ménage"))).toHaveLength(3);
    expect(session.params["metadata[tenantId]"]).toBe(TENANT_ID);
    const dossierId = session.params["metadata[dossierId]"];
    expect(session.params["cancel_url"]).toContain("/reserver/chambres?");

    // DB : 1 Dossier, 3 réservations pending, 1 paiement du total.
    const { rows: books } = await pool.query(
      "SELECT room_id, status, guest_count, child_count, total_price, guest_name FROM bookings WHERE dossier_id = $1 ORDER BY guest_count DESC",
      [dossierId],
    );
    expect(books).toHaveLength(3);
    expect(books.every((b) => b.status === "pending")).toBe(true);
    expect(books.map((b) => [b.guest_count, b.child_count, b.total_price])).toEqual([
      [4, 0, "304.00"],
      [3, 1, "240.00"],
      [2, 1, "179.00"],
    ]);
    expect(books[0].guest_name).toBe(`Hélène ${xss}`);
    const { rows: pays } = await pool.query("SELECT amount, status FROM payments WHERE dossier_id = $1", [dossierId]);
    expect(pays).toEqual([{ amount: "723.00", status: "pending" }]);

    // Paiement reçu (webhook simulé) : les 3 réservations confirmées.
    const payload = JSON.stringify({
      id: `evt_dossier_${Date.now()}`,
      type: "checkout.session.completed",
      data: { object: { id: session.sessionId, payment_intent: `pi_dossier_${Date.now()}`, metadata: { dossierId, tenantId: TENANT_ID } } },
    });
    const res = await request.post("http://localhost:3001/api/webhooks/stripe", {
      data: payload,
      headers: { "content-type": "application/json", "stripe-signature": sign(payload) },
    });
    expect(res.status()).toBe(200);
    const { rows: after } = await pool.query("SELECT status FROM bookings WHERE dossier_id = $1", [dossierId]);
    expect(after.map((b) => b.status)).toEqual(["confirmed", "confirmed", "confirmed"]);

    // Confirmation : toutes les chambres, le total, le nom échappé, jamais « Dossier ».
    await page.reload();
    await expect(page.getByText("Réservation confirmée")).toBeVisible();
    await expect(page.getByText("Vos 3 chambres sont réservées")).toBeVisible();
    for (const name of ["La Grange", "Le Fournil", "Le Lavoir"]) await expect(page.getByText(new RegExp(name)).first()).toBeVisible();
    await expect(page.locator(".s-confirm-card")).toContainText(/723\s€/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(xss);
    expect(await page.locator("body").innerText()).not.toMatch(/dossier/i);
    expect(dialogs).toEqual([]);
  });

  test("modifier la combinaison : retirer, ajouter, échanger, répartir ; refus affichés et paiement bloqué", async ({ page }) => {
    await open(page, groupUrl(7, 2));
    const pay = page.getByTestId("booking-submit");
    await expect(pay).toBeEnabled();

    // Retirer le Lavoir : 7 places pour 9 → il manque de la place, paiement bloqué.
    await roomCard(page, "lavoir").getByRole("button", { name: "Retirer cette chambre" }).click();
    await expect(page.getByTestId("dossier-room")).toHaveCount(2);
    await expect(page.getByTestId("dossier-errors")).toContainText("Ces chambres accueillent 7 personnes, vous êtes 9 : ajoutez une chambre.");
    await expect(pay).toBeDisabled();
    await expect(page.getByTestId("booking-summary-total")).toHaveText("—");

    // Ajouter le Pigeonnier : de nouveau 9 places, répartition automatique.
    await page.getByTestId("dossier-add").getByRole("button", { name: "Ajouter Le Pigeonnier" }).click();
    await expect(page.getByTestId("dossier-room")).toHaveCount(3);
    await expect(page.getByTestId("dossier-placed")).toContainText("9 voyageurs placés sur 9");
    await expect(pay).toBeEnabled();

    // Échanger le Fournil contre l'Étable (même capacité, 90 €/nuit).
    await roomCard(page, "fournil").getByLabel("Échanger contre").selectOption(id.etable);
    expect(await shownRooms(page)).toEqual(keysOf("grange", "etable", "pigeonnier"));
    // 200 + 180 + 140 d'hébergement + 3 × 20 de ménage + taxe (4 + 2 + 1 adultes) × 1,5 × 2 = 601 €.
    await expect(page.getByTestId("booking-summary-total")).toHaveText(/601\s€/);

    // Répartition : la Grange à 4 adultes + 1 enfant = 5 > 4 places.
    const grange = roomCard(page, "grange");
    await grange.getByLabel("Enfants").selectOption("1");
    await expect(grange.getByTestId("dossier-room-error")).toContainText("accueille 4 personnes maximum");
    await expect(pay).toBeDisabled();
    await grange.getByLabel("Enfants").selectOption("0");

    // Chambre sans adulte : le Pigeonnier à 0 adulte + 2 enfants.
    const pig = roomCard(page, "pigeonnier");
    await pig.getByLabel("Adultes").selectOption("0");
    await pig.getByLabel("Enfants").selectOption("2");
    await expect(pig.getByTestId("dossier-room-error")).toContainText("au moins un adulte");
    await expect(pay).toBeDisabled();

    // Changer le groupe : nouvelle répartition automatique, de nouveau valide.
    await page.locator("#party-adults").selectOption("6");
    await expect(page.getByTestId("dossier-placed")).toContainText("8 voyageurs placés sur 8");
    await expect(page.getByTestId("dossier-room-error")).toHaveCount(0);
    await expect(pay).toBeEnabled();
  });

  test("serveur : capacité insuffisante, mineurs > personnes, chambre sans adulte, répartition incohérente → refus, rien n'est créé", async ({ page }) => {
    const email = "refus.bocage@example.com";
    await open(page, groupUrl(7, 2));
    await fillGuestContact(page, { lastName: "Refus", email });
    const cases: [unknown, string][] = [
      // 9 personnes dans 2 + 2 places.
      [
        [
          { roomId: id.lavoir, guests: 5, minors: 1 },
          { roomId: id.pigeonnier, guests: 4, minors: 1 },
        ],
        "accueille 2 personnes maximum",
      ],
      [
        [
          { roomId: id.grange, guests: 4, minors: 0 },
          { roomId: id.fournil, guests: 3, minors: 0 },
          { roomId: id.lavoir, guests: 2, minors: 3 },
        ],
        "plus d'enfants que de personnes",
      ],
      [
        [
          { roomId: id.grange, guests: 4, minors: 0 },
          { roomId: id.fournil, guests: 3, minors: 0 },
          { roomId: id.lavoir, guests: 2, minors: 2 },
        ],
        "au moins un adulte",
      ],
      [[{ roomId: id.grange, guests: 4, minors: 0 }], "ajoutez une chambre"],
      [[{ roomId: id.grange, guests: 4, minors: 1 }, { roomId: id.grange, guests: 4, minors: 1 }], "choisie deux fois"],
      ["pas du json", "Choisissez vos chambres"],
      [[], "Choisissez au moins une chambre"],
    ];
    for (const [plan, message] of cases) {
      // Budget de 5 envois / 10 min par IP : une IP par envoi.
      await page.setExtraHTTPHeaders({ "x-forwarded-for": `10.14.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}` });
      await submitForgedPlan(page, plan);
      await expect(page.getByTestId("booking-error"), JSON.stringify(plan)).toContainText(message);
    }
    expect(await countDossiers(email)).toEqual({ d: 0, b: 0 });
    expect(stripe.sessions).toHaveLength(0);
  });

  test("course : une chambre prise juste avant de payer → rien n'est créé, nouvelle combinaison proposée", async ({ page }) => {
    const email = "course.bocage@example.com";
    await open(page, groupUrl(7, 2));
    expect(await shownRooms(page)).toEqual(keysOf("grange", "fournil", "lavoir"));
    await fillGuestContact(page, { lastName: "Course", email });

    // Quelqu'un réserve le Fournil pendant que le voyageur remplit le formulaire.
    const other = await insertDossier(pool, TENANT_ID, { checkIn: CHECK_IN, checkOut: CHECK_OUT, guestName: "Autre", guestEmail: "autre@example.com" });
    await pool.query(
      `INSERT INTO bookings (tenant_id, dossier_id, room_id, check_in, check_out, total_price, status, guest_name, guest_email, guest_count, source)
       VALUES ($1, $2, $3, $4, $5, '160.00', 'confirmed', 'Autre', 'autre@example.com', 2, 'direct')`,
      [TENANT_ID, other, id.fournil, CHECK_IN, CHECK_OUT],
    );

    await page.getByTestId("booking-submit").click();
    await expect(page.getByTestId("booking-error")).toContainText("n'est plus disponible");
    await expect(page.getByTestId("booking-error")).toContainText("Rien n'a été réservé");
    // Nouvelle proposition sans le Fournil : Grange + Étable + Lavoir (250 €/nuit).
    expect(await shownRooms(page)).toEqual(keysOf("grange", "etable", "lavoir"));
    await expect(page.getByTestId("dossier-add")).not.toContainText("Le Fournil");
    expect(await countDossiers(email)).toEqual({ d: 0, b: 0 });
    expect(stripe.sessions).toHaveLength(0);
    // La saisie du voyageur est conservée.
    await expect(page.locator("#guestLastName")).toHaveValue("Course");
  });

  test("isolation : une chambre d'un autre tenant n'est jamais proposée ni réservée", async ({ page }) => {
    const email = "rival.bocage@example.com";
    await open(page, `${groupUrl(1, 0)}&rooms=${ctx.rivalRoomId}`);
    await expect(page.getByTestId("dossier-room")).toHaveCount(1);
    expect(await shownRooms(page)).not.toContain(ctx.rivalRoomId);
    await fillGuestContact(page, { lastName: "Rival", email });
    await submitForgedPlan(page, [{ roomId: ctx.rivalRoomId, guests: 1, minors: 0 }]);
    await expect(page.getByTestId("booking-error")).toContainText("n'est plus disponible");
    expect(await countDossiers(email)).toEqual({ d: 0, b: 0 });
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM bookings WHERE room_id = $1 AND guest_email = $2", [ctx.rivalRoomId, email]);
    expect(rows[0].n).toBe(0);
  });

  test("paramètres invalides ou absents → message et lien vers la recherche, jamais 500", async ({ page }) => {
    const bad = [
      "",
      "?checkIn=abc&checkOut=def&adults=2",
      `?checkIn=${CHECK_OUT}&checkOut=${CHECK_IN}&adults=2`,
      "?checkIn=2020-01-01&checkOut=2020-01-03&adults=2",
      `?checkIn=${CHECK_IN}&checkOut=${CHECK_OUT}&adults=0`,
      `?checkIn=${CHECK_IN}&checkOut=${CHECK_OUT}&adults=abc&minors=-1`,
      `?checkIn=${CHECK_IN}&checkOut=${CHECK_OUT}&adults=40&minors=20`,
    ];
    for (const qs of bad) {
      const res = await page.goto(`${SITE}/reserver/chambres${qs}`);
      expect(res?.status(), qs || "(sans paramètre)").toBe(200);
      await expect(page.getByTestId("dossier-invalid"), qs).toBeVisible();
      await expect(page.getByRole("link", { name: "Choisir mes dates" })).toBeVisible();
    }
    // Chambres inconnues / malformées dans l'URL : ignorées, la combinaison est proposée.
    const res = await page.goto(`${groupUrl(3, 0)}&rooms=00000000-0000-4000-8000-000000000000,abc,,`);
    expect(res?.status()).toBe(200);
    await expect(page.getByTestId("dossier-room")).toHaveCount(1);
    await expect(page.getByTestId("dossier-dropped")).toBeVisible();
    // Groupe impossible (15 personnes) : message, pas de formulaire.
    await page.goto(groupUrl(13, 2));
    await expect(page.getByTestId("dossier-none")).toContainText("Pas assez de place");
  });

  test("API combinaison : paramètres invalides → 400, champs publics seulement", async ({ request }) => {
    const get = (q: Record<string, string>) => request.get(`${SITE}/api/rooms/combination`, { params: q });
    const invalid: Record<string, string>[] = [
      {},
      { from: "abc", to: CHECK_OUT, adults: "2" },
      { from: CHECK_OUT, to: CHECK_IN, adults: "2" },
      { from: CHECK_IN, to: CHECK_OUT, adults: "0" },
      { from: CHECK_IN, to: CHECK_OUT, adults: "2.5" },
      { from: CHECK_IN, to: CHECK_OUT, adults: "40", minors: "20" },
      { from: CHECK_IN, to: CHECK_OUT, adults: "2", minors: "-1" },
    ];
    for (const q of invalid) {
      expect((await get(q)).status(), JSON.stringify(q)).toBe(400);
    }
    const ok = await get({ from: CHECK_IN, to: CHECK_OUT, adults: "7", minors: "2" });
    expect(ok.status()).toBe(200);
    const body = await ok.text();
    expect(JSON.parse(body)).toMatchObject({ ok: true, totalPrice: 480 });
    expect(body).not.toContain("Code boîte à clés");
  });

  test("règle qui écarte les chambres (nuits min) : la raison est dite, jamais « Complet »", async ({ page, request }) => {
    const { rows: [rule] } = await pool.query(
      "INSERT INTO booking_rules (tenant_id, min_stay) VALUES ($1, 3) RETURNING id",
      [TENANT_ID],
    );
    try {
      const res = await request.get(`${SITE}/api/rooms/combination`, {
        params: { from: CHECK_IN, to: CHECK_OUT, adults: "7", minors: "2" },
      });
      expect(await res.json()).toMatchObject({ ok: false, maxCapacity: 0, rules: ["Séjour minimum de 3 nuits"] });

      await open(page, `${SITE}/`);
      await expect(async () => {
        await page.fill("#search-checkin", CHECK_IN);
        await page.fill("#search-checkout", CHECK_OUT);
        await page.selectOption("#search-adults", "7");
        await page.selectOption("#search-minors", "2");
        await page.getByRole("button", { name: "Voir les disponibilités" }).click();
        await expect(page.getByTestId("search-no-room")).toBeVisible({ timeout: 3000 });
      }).toPass({ timeout: 20_000 });
      await expect(page.getByTestId("search-no-room")).toContainText("Séjour minimum de 3 nuits");
      await expect(page.getByTestId("search-no-room")).not.toContainText("Complet");

      // Page multi-chambres ouverte par un lien : même raison.
      await page.goto(groupUrl(7, 2));
      await expect(page.getByTestId("dossier-none")).toContainText("Séjour minimum de 3 nuits");
    } finally {
      await pool.query("DELETE FROM booking_rules WHERE id = $1", [rule.id]);
    }
  });

  test("Stripe indisponible : rien n'est gardé, message clair", async ({ page }) => {
    const email = "stripe.down@example.com";
    await stripe.close();
    try {
      await open(page, groupUrl(5, 0));
      await fillGuestContact(page, { lastName: "Panne", email });
      await page.getByTestId("booking-submit").click();
      await expect(page.getByTestId("booking-error")).toContainText("paiement en ligne est momentanément indisponible");
      expect(await countDossiers(email)).toEqual({ d: 0, b: 0 });
    } finally {
      stripe = await startFakeStripe();
    }
  });

  for (const template of ["classic", "boutique", "affiche", "standard"]) {
    test(`template ${template} : la page s'affiche, téléphone sans défilement horizontal`, async ({ page }) => {
      await pool.query("UPDATE tenants SET config = config || $1::jsonb WHERE id = $2", [JSON.stringify({ template }), TENANT_ID]);
      await page.setViewportSize({ width: 360, height: 740 });
      await open(page, groupUrl(7, 2));
      await expect(page.getByTestId("dossier-room")).toHaveCount(3);
      await expect(page.getByTestId("booking-bar-submit")).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    });
  }
});
