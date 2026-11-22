import { Pool } from "pg";
import { test, expect, type Page } from "@playwright/test";
import { fd } from "../helpers/dates";
import { fillGuestContact } from "../helpers/guest";
import { startFakeStripe, type FakeStripe } from "../helpers/fake-stripe";
import { CGV_ANNEX_HEADING, PLATFORM_HOST_IDENTITY } from "../../lib/legal-documents";

/**
 * Spécification : Tests de non-régression > Public > Documents légaux
 * Référence : .scratch/remboursements-litiges/issues/01-legal-documents.md
 *
 * Tenant dédié `legal-tenant` (id fixe : le proxy garde le tenant 5 min en cache par host),
 * deux chambres à lui, supprimé à la fin. Les documents se publient/dépublient en base :
 * les pages relisent le tenant à chaque requête.
 * Stripe : faux serveur local (e2e/helpers/fake-stripe.ts).
 */

const TENANT_ID = "1e9a1000-0000-4000-8000-0000000000a1";
const SLUG = "legal-tenant";
const SITE = `http://${SLUG}.localhost:3001`;
const ACCOUNT = "acct_test_e2e_legal";
const NAME = "Gîte des Haies";
const CONFIG = { address: "4 rue du Lavoir\n85590 Les Épesses", email: "contact@gite-des-haies.fr", phone: "02 51 00 00 00" };
const IDENTITY = {
  legal_name: "SARL Les Haies",
  legal_form: "SARL au capital de 5 000 €",
  siret: "98765432100017",
  publication_director: "Paul Bocage",
  mediator: "Médiateur Test, www.mediateur.example",
};
const PAGES = [
  { path: "/conditions-annulation", title: "Conditions d'annulation", marker: "jusqu'à 7 jours avant" },
  { path: "/cgv", title: "Conditions générales de vente", marker: "L221-28 12°" },
  { path: "/mentions-legales", title: "Mentions légales", marker: "987 654 321 00017" },
  { path: "/confidentialite", title: "Politique de confidentialité", marker: "CNIL" },
] as const;
const TEMPLATES = [
  { key: "classic", tpl: "plaque" },
  { key: "boutique", tpl: "linge" },
  { key: "affiche", tpl: "affiche" },
  { key: "standard", tpl: "standard" },
] as const;
const ADMIN_ONLY = "Modèle fourni à titre indicatif";

const IN = fd("2026-09-14");
const OUT = fd("2026-09-16");

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
let stripe: FakeStripe;
const roomIds: string[] = [];

async function purgeData() {
  await pool.query("DELETE FROM payments WHERE tenant_id = $1", [TENANT_ID]);
  await pool.query("DELETE FROM bookings WHERE tenant_id = $1", [TENANT_ID]);
  await pool.query("DELETE FROM dossiers WHERE tenant_id = $1", [TENANT_ID]);
}

async function purgeAll() {
  await purgeData();
  await pool.query("DELETE FROM rooms WHERE tenant_id = $1", [TENANT_ID]);
  await pool.query("DELETE FROM properties WHERE tenant_id = $1", [TENANT_ID]);
  await pool.query("DELETE FROM tenants WHERE id = $1", [TENANT_ID]);
}

/** Publie les documents (identité complète, niveau et textes au choix). */
async function publish(patch: Record<string, string | null> = {}) {
  const cols = { ...IDENTITY, cancellation_level: "moderate", cancellation_text: null, cgv_text: null, legal_notice_text: null, privacy_text: null, ...patch };
  const keys = Object.keys(cols);
  await pool.query(
    `UPDATE tenants SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")}, legal_published_at = now() WHERE id = $1`,
    [TENANT_ID, ...keys.map((k) => cols[k as keyof typeof cols])],
  );
}

async function unpublish() {
  await pool.query(
    `UPDATE tenants SET legal_published_at = NULL, legal_name = NULL, legal_form = NULL, siret = NULL, publication_director = NULL,
       mediator = NULL, cancellation_level = 'moderate', cancellation_text = NULL, cgv_text = NULL, legal_notice_text = NULL, privacy_text = NULL
     WHERE id = $1`,
    [TENANT_ID],
  );
}

async function setTemplate(key: string) {
  await pool.query("UPDATE tenants SET config = config || $2::jsonb WHERE id = $1", [TENANT_ID, JSON.stringify({ template: key })]);
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await purgeAll();
  await pool.query(`INSERT INTO tenants (id, name, slug, config, stripe_account_id) VALUES ($1, $2, $3, $4::jsonb, $5)`, [
    TENANT_ID,
    NAME,
    SLUG,
    JSON.stringify(CONFIG),
    ACCOUNT,
  ]);
  const {
    rows: [prop],
  } = await pool.query("INSERT INTO properties (tenant_id, name) VALUES ($1, $2) RETURNING id", [TENANT_ID, NAME]);
  for (const [i, price] of [80, 90].entries()) {
    const { rows } = await pool.query(
      `INSERT INTO rooms (tenant_id, property_id, name, slug, price_per_night, capacity) VALUES ($1, $2, $3, $4, $5, 2) RETURNING id`,
      [TENANT_ID, prop.id, `Chambre légale ${i + 1}`, `legal-room-${i + 1}`, price.toFixed(2)],
    );
    roomIds.push(rows[0].id);
  }
  stripe = await startFakeStripe();
});

test.afterAll(async () => {
  await stripe?.close();
  await purgeAll();
  await pool.end();
});

test.beforeEach(async ({ page }) => {
  await unpublish();
  await setTemplate("classic");
  stripe.sessions.length = 0;
  // Le formulaire est limité à 5 envois / 10 min par IP : une IP par test.
  await page.setExtraHTTPHeaders({
    "x-forwarded-for": `10.31.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`,
  });
});

test.afterEach(purgeData);

/** Aucun dialog ne doit s'ouvrir (XSS). */
function trackDialogs(page: Page) {
  const dialogs: string[] = [];
  page.on("dialog", (d) => {
    dialogs.push(d.message());
    void d.dismiss();
  });
  return dialogs;
}

async function submitOneRoom(page: Page, email: string) {
  await page.goto(`${SITE}/reserver/${roomIds[0]}?checkIn=${IN}&checkOut=${OUT}`);
  await page.waitForLoadState("networkidle");
  await expect(page.getByText("Disponible", { exact: true })).toBeVisible({ timeout: 8000 });
  await fillGuestContact(page, { lastName: "Légal", email });
  await page.getByTestId("booking-submit").click();
  await expect(page).toHaveURL(/\/reserver\/confirmation\?session_id=cs_test_fake_/, { timeout: 15_000 });
}

const groupUrl = `${SITE}/reserver/chambres?checkIn=${IN}&checkOut=${OUT}&adults=3&minors=0`;

async function dossierOf(email: string) {
  const { rows } = await pool.query(
    `SELECT cancellation_level, accepted_cancellation_text, accepted_cgv_text, terms_accepted_at,
            extract(epoch FROM terms_accepted_at) * 1000 AS accepted_ms,
            (SELECT count(*)::int FROM bookings b WHERE b.dossier_id = d.id) AS rooms
     FROM dossiers d WHERE tenant_id = $1 AND guest_email = $2`,
    [TENANT_ID, email],
  );
  expect(rows).toHaveLength(1);
  return rows[0];
}

test.describe("Documents légaux — site public", () => {
  test("non publiés : 4 pages minimales (nom, adresse, hébergeur), non indexées ; aucune mention au paiement", async ({ page }) => {
    for (const p of PAGES) {
      const res = await page.goto(`${SITE}${p.path}`);
      expect(res?.status()).toBe(200);
      await expect(page.getByRole("heading", { level: 1, name: p.title })).toBeVisible();
      const minimal = page.getByTestId("legal-minimal");
      await expect(minimal).toContainText(NAME);
      await expect(minimal).toContainText("4 rue du Lavoir, 85590 Les Épesses");
      await expect(minimal).toContainText(PLATFORM_HOST_IDENTITY);
      await expect(page.getByTestId("legal-text")).toHaveCount(0);
      await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
      await expect(page.locator("body")).not.toContainText(ADMIN_ONLY);
      await expect(page.locator("body")).not.toContainText(p.marker);
    }
    await page.goto(`${SITE}/reserver/${roomIds[0]}`);
    await expect(page.getByTestId("booking-submit")).toBeVisible();
    await expect(page.getByTestId("booking-terms")).toHaveCount(0);
  });

  for (const { key, tpl } of TEMPLATES) {
    test(`publiés, template ${key} : pied de page → 4 pages complètes, sans mention « modèle »`, async ({ page }) => {
      await publish();
      await setTemplate(key);
      await page.goto(`${SITE}/`);
      await expect(page.locator(`.site[data-tpl="${tpl}"]`)).toBeVisible();
      const footer = page.getByTestId("footer-legal");
      await expect(footer.getByRole("link")).toHaveCount(4);
      for (const p of PAGES) {
        await page.goto(`${SITE}/`);
        const link = page.getByTestId("footer-legal").getByRole("link", { name: p.title });
        await expect(link).toHaveAttribute("href", p.path);
        // Le bandeau de consentement (PostHog en dev) peut couvrir le pied de page.
        await link.dispatchEvent("click");
        await expect(page).toHaveURL(`${SITE}${p.path}`);
        await expect(page.getByRole("heading", { level: 1, name: p.title })).toBeVisible();
        const text = page.getByTestId("legal-text");
        await expect(text).toContainText(p.marker);
        await expect(text.locator("h2").first()).toBeVisible();
        await expect(page.locator("body")).not.toContainText(ADMIN_ONLY);
        await expect(page.locator("body")).not.toContainText("[à compléter]");
        await expect(page.locator('meta[name="robots"]')).toHaveCount(0);
        // Rien ne déborde sur téléphone.
        await page.setViewportSize({ width: 360, height: 760 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
        await page.setViewportSize({ width: 1280, height: 720 });
      }
    });
  }

  test("CGV publiées : les conditions d'annulation en vigueur sont reprises en annexe", async ({ page }) => {
    await publish({ cancellation_level: "strict" });
    await page.goto(`${SITE}/cgv`);
    await expect(page.getByRole("heading", { name: CGV_ANNEX_HEADING })).toBeVisible();
    await expect(page.getByTestId("legal-text")).toContainText("jusqu'à 30 jours avant");
  });

  test("XSS : textes et champs de l'hôte affichés tels quels, aucun script exécuté", async ({ page }) => {
    const dialogs = trackDialogs(page);
    const xss = "<script>alert(1)</script>";
    const img = "<img src=x onerror=alert(2)>";
    await publish({
      cgv_text: `## ${img}\n${xss}\n- ${img}`,
      legal_name: `SARL ${xss}`,
      cancellation_level: "custom",
      cancellation_text: `Texte ${img}`,
    });
    for (const p of ["/cgv", "/mentions-legales", "/conditions-annulation"]) {
      await page.goto(`${SITE}${p}`);
      await page.waitForLoadState("networkidle");
      const body = page.getByTestId("legal-text");
      await expect(body.locator("script, img")).toHaveCount(0);
    }
    await page.goto(`${SITE}/cgv`);
    await expect(page.getByRole("heading", { name: img })).toBeVisible();
    await expect(page.getByTestId("legal-text")).toContainText(xss);
    await page.goto(`${SITE}/mentions-legales`);
    await expect(page.getByTestId("legal-text")).toContainText(`SARL ${xss}`);
    expect(dialogs).toEqual([]);
  });

  test("mention au paiement (une chambre, plusieurs chambres) : liens vers les conditions et les CGV, résumé du niveau", async ({ page }) => {
    await publish();
    await page.goto(`${SITE}/reserver/${roomIds[0]}`);
    const terms = page.getByTestId("booking-terms");
    await expect(terms).toContainText("En payant, vous acceptez les conditions d'annulation et les CGV de l'établissement.");
    await expect(terms).toContainText("remboursement intégral jusqu'à 7 jours avant l'arrivée, 50 % ensuite");
    await expect(terms.getByRole("link", { name: "conditions d'annulation" })).toHaveAttribute("href", "/conditions-annulation");
    await expect(terms.getByRole("link", { name: "CGV" })).toHaveAttribute("href", "/cgv");
    await expect(terms.getByRole("link", { name: "CGV" })).toHaveAttribute("target", "_blank");

    await page.goto(groupUrl);
    await expect(page.getByTestId("booking-terms")).toContainText("En payant, vous acceptez");

    // Conditions personnalisées : pas de résumé inventé.
    await publish({ cancellation_level: "custom", cancellation_text: "Aucun remboursement." });
    await page.goto(`${SITE}/reserver/${roomIds[0]}`);
    await expect(page.getByTestId("booking-terms")).not.toContainText("Annulation :");
  });

  test("réservation d'une chambre : texte exact des conditions et des CGV copié sur le Dossier, figé ensuite", async ({ page }) => {
    const custom = `## Mes conditions\nRemboursement de 80 % jusqu'à 10 jours avant (legal-e2e ${Date.now()}).`;
    await publish({ cancellation_level: "custom", cancellation_text: custom, cgv_text: "## Mes CGV\nArticle unique." });
    const email = `legal-one-${Date.now()}@example.com`;
    const before = Date.now();
    await submitOneRoom(page, email);
    const d = await dossierOf(email);
    expect(d.cancellation_level).toBe("custom");
    expect(d.accepted_cancellation_text).toBe(custom);
    expect(d.accepted_cgv_text).toBe(`## Mes CGV\nArticle unique.\n\n## ${CGV_ANNEX_HEADING}\n${custom}`);
    // Colonne sans fuseau, écrite en UTC : l'époque se lit côté SQL.
    expect(Number(d.accepted_ms)).toBeGreaterThan(before - 60_000);
    expect(Number(d.accepted_ms)).toBeLessThan(Date.now() + 60_000);

    // L'hôte change ses textes ensuite : la preuve du Dossier ne bouge pas.
    await publish({ cancellation_level: "flexible", cgv_text: "## Nouvelles CGV" });
    const after = await dossierOf(email);
    expect(after.accepted_cancellation_text).toBe(custom);
    expect(after.accepted_cgv_text).toContain("Article unique.");
  });

  test("réservation de plusieurs chambres : la copie est faite aussi (modèle modéré rempli)", async ({ page }) => {
    await publish();
    const email = `legal-group-${Date.now()}@example.com`;
    await page.goto(groupUrl);
    await page.waitForLoadState("networkidle");
    await expect(page.getByTestId("dossier-room")).toHaveCount(2);
    await fillGuestContact(page, { lastName: "Groupe", email });
    await page.getByTestId("booking-submit").click();
    await expect(page).toHaveURL(/\/reserver\/confirmation\?session_id=cs_test_fake_/, { timeout: 15_000 });
    const d = await dossierOf(email);
    expect(d.rooms).toBe(2);
    expect(d.cancellation_level).toBe("moderate");
    expect(d.accepted_cancellation_text).toContain("jusqu'à 7 jours avant");
    expect(d.accepted_cgv_text).toContain("SARL Les Haies");
    expect(d.accepted_cgv_text).toContain(CGV_ANNEX_HEADING);
    expect(d.terms_accepted_at).not.toBeNull();
  });

  test("non publiés : la réservation passe, sans aucune copie sur le Dossier", async ({ page }) => {
    const email = `legal-none-${Date.now()}@example.com`;
    await submitOneRoom(page, email);
    const d = await dossierOf(email);
    expect(d).toMatchObject({ cancellation_level: null, accepted_cancellation_text: null, accepted_cgv_text: null, accepted_ms: null });
  });

  test("isolation : les documents d'un autre tenant n'apparaissent jamais", async ({ page }) => {
    const { rows } = await pool.query(
      "SELECT id, legal_name, cgv_text, legal_published_at FROM tenants WHERE slug = 'rival-hotel'",
    );
    test.skip(rows.length === 0, "tenant rival absent");
    const rival = rows[0];
    const marker = `RIVAL-CGV-${Date.now()}`;
    await pool.query("UPDATE tenants SET legal_name = $2, cgv_text = $3, legal_published_at = now() WHERE id = $1", [
      rival.id,
      `${marker} SAS`,
      `## ${marker}`,
    ]);
    try {
      await publish();
      for (const p of ["/cgv", "/mentions-legales", "/confidentialite"]) {
        await page.goto(`${SITE}${p}`);
        await expect(page.getByTestId("legal-text")).toBeVisible();
        await expect(page.locator("body")).not.toContainText(marker);
      }
      // Et l'inverse : le site du rival montre ses propres textes, pas ceux de legal-tenant.
      await page.goto(`http://rival-hotel.localhost:3001/cgv`);
      await expect(page.getByTestId("legal-text")).toContainText(marker);
      await expect(page.locator("body")).not.toContainText("SARL Les Haies");
    } finally {
      await pool.query("UPDATE tenants SET legal_name = $2, cgv_text = $3, legal_published_at = $4 WHERE id = $1", [
        rival.id,
        rival.legal_name,
        rival.cgv_text,
        rival.legal_published_at,
      ]);
    }
  });

  test("démo : documents publiés d'office (pages complètes, mention au paiement)", async ({ page }) => {
    await page.goto("http://demo-tenant.localhost:3001/mentions-legales");
    await expect(page.getByTestId("legal-text")).toContainText("Le Mas des Oliviers");
    await expect(page.locator("body")).not.toContainText(ADMIN_ONLY);
    await page.goto("http://demo-tenant.localhost:3001/conditions-annulation");
    await expect(page.getByTestId("legal-text")).toContainText("jusqu'à 7 jours avant");
  });

  test("hôte inconnu : pages légales en 404, jamais 500", async ({ page }) => {
    for (const p of PAGES) {
      const res = await page.goto(`http://tenant-inexistant.localhost:3001${p.path}`);
      expect(res?.status()).toBe(404);
    }
  });
});
