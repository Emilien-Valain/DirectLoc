import { test, expect } from "@playwright/test";
import http from "http";
import fs from "fs";
import path from "path";
import { eq, sql } from "drizzle-orm";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { tenants } from "../../db/schema";

/**
 * Inscription Google Search Console (lib/google-search-console.ts) contre un faux Google (port 3996).
 * Spécification : Tests de non-régression > Search Console
 */

const DOMAIN = "test-tenant.example";
const SITE = `https://${DOMAIN}/`;
const ctx = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "e2e", ".auth", "test-context.json"), "utf-8"),
) as { tenantId: string };
const secret = process.env.CRON_SECRET;

type Call = { method: string; url: string; body: string };
const calls: Call[] = [];
let failVerification = false;
let failOwnersRead = false;
let server: http.Server;
let pool: Pool;

const db = () => drizzle(pool);
const config = async () =>
  ((await db().select({ c: tenants.config }).from(tenants).where(eq(tenants.id, ctx.tenantId)))[0].c ?? {}) as Record<string, unknown>;
const resetConfig = () =>
  db().update(tenants)
    .set({ config: sql`coalesce(${tenants.config}, '{}'::jsonb) - 'googleSiteVerification' - 'searchConsoleAddedAt' - 'searchConsoleOwners'` })
    .where(eq(tenants.id, ctx.tenantId));

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      calls.push({ method: req.method!, url: req.url!, body });
      const json = (code: number, o: object) => res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(o));
      if (req.url === "/token") return json(200, { access_token: "fake-access" });
      if (req.url === "/siteVerification/v1/token")
        return json(200, { method: "META", token: '<meta name="google-site-verification" content="fake-verif-123" />' });
      if (req.url!.startsWith("/siteVerification/v1/webResource?")) {
        if (failVerification) return json(400, { error: { message: "verification failed" } });
        return json(200, { id: encodeURIComponent(SITE), owners: ["sa@test.iam.gserviceaccount.com"] });
      }
      if (req.method === "GET" && req.url!.startsWith("/siteVerification/v1/webResource/")) {
        if (failOwnersRead) return json(500, { error: { message: "backend error" } });
        return json(200, { id: encodeURIComponent(SITE), owners: ["sa@test.iam.gserviceaccount.com"] });
      }
      json(200, {});
    });
  });
  await new Promise<void>((resolve) => server.listen(3996, resolve));
  pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL! });
  await db().update(tenants).set({ domain: DOMAIN }).where(eq(tenants.id, ctx.tenantId));
  await resetConfig();
});

test.afterAll(async () => {
  await db().update(tenants).set({ domain: null }).where(eq(tenants.id, ctx.tenantId));
  await resetConfig();
  await pool.end();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("sans Authorization ou avec un faux jeton → jamais 200", async ({ request }) => {
  expect([401, 500]).toContain((await request.get("/api/cron/search-console")).status());
  const res = await request.get("/api/cron/search-console", { headers: { Authorization: "Bearer faux" } });
  expect(res.status()).not.toBe(200);
});

test("vérification refusée : jeton gardé et rendu en meta, site non marqué, retenté ensuite", async ({ request, page }) => {
  test.skip(!secret, "CRON_SECRET non configuré dans l'environnement de test");
  failVerification = true;
  const res = await request.get("/api/cron/search-console", { headers: { Authorization: `Bearer ${secret}` } });
  expect(res.status()).toBe(200);
  expect((await res.json()).sites[DOMAIN]).toContain("échec");

  const c = await config();
  expect(c.googleSiteVerification).toBe("fake-verif-123");
  expect(c.searchConsoleAddedAt).toBeUndefined();
  expect(calls.some((x) => x.url.startsWith("/webmasters/"))).toBe(false);

  await page.goto("/");
  expect(await page.locator('meta[name="google-site-verification"]').getAttribute("content")).toBe("fake-verif-123");
});

test("vérification acceptée : propriétaire ajouté et enregistré, site et sitemap envoyés, puis plus jamais retraité", async ({ request }) => {
  test.skip(!secret, "CRON_SECRET non configuré dans l'environnement de test");
  failVerification = false;
  calls.length = 0;
  const res = await request.get("/api/cron/search-console", { headers: { Authorization: `Bearer ${secret}` } });
  expect((await res.json()).sites[DOMAIN]).toBe("inscrit");

  // Jeton déjà en base : pas redemandé.
  expect(calls.some((x) => x.url === "/siteVerification/v1/token")).toBe(false);
  const owners = calls.find((x) => x.method === "PUT" && x.url.startsWith("/siteVerification/v1/webResource/"));
  expect(JSON.parse(owners!.body).owners).toEqual(["sa@test.iam.gserviceaccount.com", "proprietaire@directloc.test"]);
  const enc = encodeURIComponent(SITE);
  expect(calls.map((x) => `${x.method} ${x.url}`)).toEqual(
    expect.arrayContaining([
      `PUT /webmasters/v3/sites/${enc}`,
      `PUT /webmasters/v3/sites/${enc}/sitemaps/${encodeURIComponent(`${SITE}sitemap.xml`)}`,
    ]),
  );
  const c = await config();
  expect(c.searchConsoleAddedAt).toBeTruthy();
  expect(c.searchConsoleOwners).toEqual(["proprietaire@directloc.test"]);

  calls.length = 0;
  const again = await request.get("/api/cron/search-console", { headers: { Authorization: `Bearer ${secret}` } });
  expect((await again.json()).sites[DOMAIN]).toBeUndefined();
  expect(calls.filter((x) => x.url !== "/token")).toHaveLength(0);
});

test("site inscrit avant l'ajout d'un propriétaire : propriétaire ajouté une seule fois, sans réinscription", async ({ request }) => {
  test.skip(!secret, "CRON_SECRET non configuré dans l'environnement de test");
  // Site inscrit sans propriétaire enregistré (GOOGLE_SEARCH_CONSOLE_OWNERS ajouté après coup).
  await db().update(tenants)
    .set({ config: sql`(coalesce(${tenants.config}, '{}'::jsonb) - 'searchConsoleOwners') || ${JSON.stringify({ searchConsoleAddedAt: "2026-01-01T00:00:00.000Z" })}::jsonb` })
    .where(eq(tenants.id, ctx.tenantId));
  const run = async () =>
    (await (await request.get("/api/cron/search-console", { headers: { Authorization: `Bearer ${secret}` } })).json()).sites[DOMAIN];

  // Google en panne : échec signalé, rien enregistré, retenté ensuite.
  failOwnersRead = true;
  calls.length = 0;
  expect(await run()).toContain("échec");
  expect((await config()).searchConsoleOwners).toBeUndefined();
  failOwnersRead = false;

  calls.length = 0;
  expect(await run()).toBe("propriétaires ajoutés");
  const put = calls.find((x) => x.method === "PUT" && x.url.startsWith("/siteVerification/v1/webResource/"));
  expect(JSON.parse(put!.body).owners).toEqual(["sa@test.iam.gserviceaccount.com", "proprietaire@directloc.test"]);
  // Ni nouvelle vérification, ni réinscription, ni sitemap renvoyé.
  expect(calls.some((x) => x.url.startsWith("/siteVerification/v1/webResource?") || x.url.startsWith("/webmasters/"))).toBe(false);
  const c = await config();
  expect(c.searchConsoleOwners).toEqual(["proprietaire@directloc.test"]);
  expect(c.searchConsoleAddedAt).toBe("2026-01-01T00:00:00.000Z");

  calls.length = 0;
  expect(await run()).toBeUndefined();
  expect(calls.filter((x) => x.url !== "/token")).toHaveLength(0);
});
