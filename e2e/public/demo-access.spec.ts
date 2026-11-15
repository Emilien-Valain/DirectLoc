import { test, expect } from "@playwright/test";
import { Pool } from "pg";

/**
 * Spécification : Tests de non-régression > Démo — accès « Essayer »
 * Référence : .scratch/demo-mode/issues/03-essayer-autologin.md
 *
 * Vitrine `/essayer` → 302 vers l'hôtel démo ; démo `/essayer` → session admin
 * propre au visiteur (2 h, sans mot de passe) puis /admin. Tout autre tenant → 404.
 * Le compte démo (demo@demo.local) est seedé par global-setup (issue 02).
 */

const VITRINE = "http://directloc.localhost:3001";
const DEMO = "http://demo-tenant.localhost:3001";
const DEMO_EMAIL = "demo@demo.local";

// IP propre au spec (et à chaque reprise) : /essayer est limité à 20 hits / min / IP.
test.use({ extraHTTPHeaders: { "x-forwarded-for": `10.20.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` } });

test.describe.configure({ mode: "serial" });

let pool: Pool;

test.beforeAll(() => {
  pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
});

test.afterAll(async () => {
  // Les sessions ouvertes par le spec ; le reset nocturne les purgerait de toute façon.
  await pool.query("DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email = $1)", [DEMO_EMAIL]);
  await pool.end();
});

test.describe("Démo — /essayer", () => {
  test("vitrine /essayer → 302 vers l'hôtel démo", async ({ request }) => {
    const res = await request.get(`${VITRINE}/essayer`, { maxRedirects: 0 });
    expect(res.status()).toBe(302);
    expect(res.headers()["location"]).toBe(`${DEMO}/essayer`);
  });

  test("vitrine /site-demo → 302 vers le site de réservation de l'hôtel démo, sans session", async ({ page, request }) => {
    const res = await request.get(`${VITRINE}/site-demo`, { maxRedirects: 0 });
    expect(res.status()).toBe(302);
    expect(res.headers()["location"]).toBe(`${DEMO}/`);
    expect(res.headers()["set-cookie"]).toBeUndefined();

    await page.goto(`${VITRINE}/`);
    await page.getByRole("link", { name: /Voir le site de réservation/ }).first().click();
    await page.waitForURL(`${DEMO}/`);
    await expect(page.getByText("Site de démonstration")).toBeVisible();
  });

  test("le bouton de la vitrine ouvre l'admin démo connecté", async ({ page }) => {
    await page.goto(`${VITRINE}/`);
    await page.getByRole("link", { name: /Essayer l'admin/ }).first().click();
    await page.waitForURL(`${DEMO}/admin`);
    await expect(page.getByRole("heading", { level: 1, name: /bonjour/i })).toBeVisible();
  });

  test("démo /essayer → /admin connecté, cookie Better Auth host-only, session de 2 h", async ({ page }) => {
    const res = await page.request.get(`${DEMO}/essayer`, { maxRedirects: 0 });
    expect(res.status()).toBe(302);
    expect(res.headers()["location"]).toBe("/admin");

    await page.goto(`${DEMO}/essayer`);
    await expect(page).toHaveURL(`${DEMO}/admin`);
    await expect(page.getByRole("heading", { level: 1, name: /bonjour/i })).toBeVisible();

    const cookie = (await page.context().cookies(DEMO)).find((c) => c.name === "better-auth.session_token");
    expect(cookie).toBeDefined();
    expect(cookie!.domain).toBe("demo-tenant.localhost");
    expect(cookie!.httpOnly).toBe(true);
    const ttl = cookie!.expires - Date.now() / 1000;
    expect(ttl).toBeGreaterThan(3600);
    expect(ttl).toBeLessThanOrEqual(2 * 3600 + 5);

    // Durée en base (expires_at - created_at) : indépendante du fuseau des colonnes sans tz.
    const { rows } = await pool.query(
      `SELECT EXTRACT(EPOCH FROM s.expires_at - s.created_at)::float AS ttl
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE u.email = $1 ORDER BY s.created_at DESC LIMIT 1`,
      [DEMO_EMAIL],
    );
    expect(rows[0].ttl).toBeGreaterThan(2 * 3600 - 5);
    expect(rows[0].ttl).toBeLessThanOrEqual(2 * 3600 + 5);

    // Une navigation de plus ne prolonge pas la session (pas de refresh à 7 jours).
    await page.goto(`${DEMO}/admin/reservations`);
    const after = (await page.context().cookies(DEMO)).find((c) => c.name === "better-auth.session_token");
    expect(after!.expires - Date.now() / 1000).toBeLessThanOrEqual(2 * 3600 + 5);
  });

  test("chaque visiteur a sa propre session", async ({ browser }) => {
    const tokens: string[] = [];
    for (let i = 0; i < 2; i++) {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await page.goto(`${DEMO}/essayer`);
      await expect(page).toHaveURL(`${DEMO}/admin`);
      tokens.push((await ctx.cookies(DEMO)).find((c) => c.name === "better-auth.session_token")!.value);
      await ctx.close();
    }
    expect(tokens[0]).not.toBe(tokens[1]);
  });

  test("la session démo ne vaut pas sur un autre tenant", async ({ page }) => {
    await page.goto(`${DEMO}/essayer`);
    await expect(page).toHaveURL(`${DEMO}/admin`);
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/login/);
  });

  test("/essayer sur test-tenant → 404, jamais de session", async ({ request }) => {
    const res = await request.get("/essayer", { maxRedirects: 0 });
    expect(res.status()).toBe(404);
    expect(res.headers()["set-cookie"] ?? "").not.toContain("session_token");
  });

  test("/essayer est limité par IP (429 au-delà de 20 / min)", async ({ playwright }) => {
    const ip = `10.21.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
    const ctx = await playwright.request.newContext({
      baseURL: "http://localhost:3001",
      extraHTTPHeaders: { "x-forwarded-for": ip },
    });
    const statuses: number[] = [];
    // test-tenant : 404 sans créer de session, mais compté quand même.
    for (let i = 0; i < 21; i++) statuses.push((await ctx.get("/essayer", { maxRedirects: 0 })).status());
    expect(statuses.slice(0, 20).every((s) => s === 404)).toBe(true);
    expect(statuses[20]).toBe(429);
    await ctx.dispose();
  });
});

test("photos démo : chaque chambre affiche sa photo servie depuis /demo/", async ({ page, request }) => {
  await page.goto(`${DEMO}/chambres`);
  const srcs = await page.locator("main img").evaluateAll((imgs) => imgs.map((i) => (i as HTMLImageElement).currentSrc));
  expect(srcs.filter((s) => s.includes("%2Fdemo%2F") || s.includes("/demo/")).length).toBeGreaterThanOrEqual(4);
  const res = await request.get(`${DEMO}/demo/chambre-lavande.webp`);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("image/webp");
  // /_next/image lit /demo/ par une requête interne sans domaine : en prod aucun tenant ne
  // correspond (en test PUBLIC_TENANT_SLUG le masque). Le proxy ne doit pas filtrer /demo/.
  const hostless = await request.get(`${DEMO}/demo/chambre-lavande.webp`, { headers: { host: "inconnu.example" } });
  expect(hostless.status()).toBe(200);
  expect(hostless.headers()["content-type"]).toContain("image/webp");
});

test.describe("Démo — bandeaux et liens croisés", () => {
  test("admin démo : bandeau + lien vers le site de réservation", async ({ page }) => {
    await page.goto(`${DEMO}/essayer`);
    const banner = page.getByTestId("demo-banner");
    await expect(banner).toContainText("Démo — données remises à zéro chaque nuit");
    const link = banner.getByRole("link", { name: "Voir le site de réservation" });
    await expect(link).toHaveAttribute("href", "/");
  });

  test("site démo : bandeau, lien « Voir l'admin » vers l'admin connecté", async ({ page }) => {
    await page.goto(`${DEMO}/`);
    const banner = page.getByTestId("demo-banner");
    await expect(banner).toContainText("Site de démonstration");
    await banner.getByRole("link", { name: "Voir l'admin" }).click();
    await expect(page).toHaveURL(`${DEMO}/admin`);
    await expect(page.getByRole("heading", { level: 1, name: /bonjour/i })).toBeVisible();
  });

  test("formulaire de réservation démo : mention carte de test", async ({ page }) => {
    const { rows } = await pool.query(
      "SELECT r.id FROM rooms r JOIN tenants t ON t.id = r.tenant_id WHERE t.slug = 'demo-tenant' LIMIT 1",
    );
    await page.goto(`${DEMO}/reserver/${rows[0].id}`);
    await expect(page.getByTestId("demo-test-card")).toContainText("4242 4242 4242 4242");
  });

  test("test-tenant : aucun bandeau démo (site, réservation, admin)", async ({ page, browser }) => {
    await page.goto("/");
    await expect(page.getByRole("heading").first()).toBeVisible();
    await expect(page.getByTestId("demo-banner")).toHaveCount(0);

    const { rows } = await pool.query(
      "SELECT r.id FROM rooms r JOIN tenants t ON t.id = r.tenant_id WHERE t.slug = 'test-tenant' LIMIT 1",
    );
    await page.goto(`/reserver/${rows[0].id}`);
    await expect(page.getByTestId("booking-reassure")).toBeVisible();
    await expect(page.getByTestId("demo-test-card")).toHaveCount(0);

    const admin = await browser.newContext({ storageState: "e2e/.auth/admin.json" });
    const adminPage = await admin.newPage();
    await adminPage.goto("http://localhost:3001/admin");
    await expect(adminPage.getByRole("heading", { level: 1, name: /bonjour/i })).toBeVisible();
    await expect(adminPage.getByTestId("demo-banner")).toHaveCount(0);
    await admin.close();
  });
});
