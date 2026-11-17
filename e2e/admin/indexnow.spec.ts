import { test, expect } from "@playwright/test";
import http from "http";
import fs from "fs";
import path from "path";
import { eq } from "drizzle-orm";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { tenants } from "../../db/schema";
import { confirmDialog } from "../helpers/confirm";
import { deleteRoomsByName } from "../helpers/intake";

/**
 * IndexNow (Bing → recherche ChatGPT) : fichier-clé, envois au fil des modifications, envoi initial.
 * Le faux point d'entrée IndexNow écoute sur INDEXNOW_ENDPOINT (playwright.config.ts, port 3997).
 * Spécification : Tests de non-régression > IndexNow
 */

const KEY = "test-indexnow-key-0123456789";
const DOMAIN = "test-tenant.example";
const VITRINE = "http://directloc.localhost:3001";
const ctx = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "e2e", ".auth", "test-context.json"), "utf-8"),
) as { tenantId: string };

type Submission = { host: string; key: string; keyLocation: string; urlList: string[] };

let pool: Pool;
let server: http.Server;
const received: Submission[] = [];

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try { received.push(JSON.parse(body)); } catch {}
      res.writeHead(200).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(3997, resolve));
  // Un hôtel sans domaine n'envoie rien : on en donne un le temps du fichier.
  pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL! });
  await drizzle(pool).update(tenants).set({ domain: DOMAIN }).where(eq(tenants.id, ctx.tenantId));
});

test.afterAll(async () => {
  await drizzle(pool).update(tenants).set({ domain: null }).where(eq(tenants.id, ctx.tenantId));
  await pool.end();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("fichier-clé servi sur le site client et sur la vitrine", async ({ request }) => {
  for (const url of ["/indexnow.txt", `${VITRINE}/indexnow.txt`]) {
    const res = await request.get(url);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/plain");
    expect(await res.text()).toBe(KEY);
  }
});

test("création puis suppression d'une chambre → URL envoyées à IndexNow", async ({ page }) => {
  const name = `Chambre IndexNow ${Date.now().toString(36)}`;
  try {
    received.length = 0;
    await page.goto("/admin/chambres/new");
    await page.fill('[name="nom"]', name);
    await page.fill('[name="prix"]', "90");
    await page.fill('[name="capacite"]', "2");
    await page.click('[type="submit"]');
    await expect(page).toHaveURL("/admin/chambres");

    await expect.poll(() => received.length).toBeGreaterThan(0);
    const created = received[0];
    expect(created.host).toBe(DOMAIN);
    expect(created.key).toBe(KEY);
    expect(created.keyLocation).toBe(`https://${DOMAIN}/indexnow.txt`);
    expect(created.urlList).toContain(`https://${DOMAIN}/chambres`);
    const roomUrl = created.urlList.find((u) => u.includes("/chambres/chambre-indexnow-"));
    expect(roomUrl).toBeTruthy();

    // La suppression signale l'URL disparue (404 à désindexer).
    received.length = 0;
    await page.locator(`[data-room-name="${name}"]`).getByRole("button", { name: "Supprimer" }).click();
    await confirmDialog(page);
    await expect(page.locator(`[data-room-name="${name}"]`)).toHaveCount(0);
    await expect.poll(() => received.flatMap((s) => s.urlList)).toContain(roomUrl);
  } finally {
    await deleteRoomsByName(ctx.tenantId, name);
  }
});

test("hôtel sans domaine → aucun envoi", async ({ page }) => {
  await drizzle(pool).update(tenants).set({ domain: null }).where(eq(tenants.id, ctx.tenantId));
  const name = `Chambre SansDomaine ${Date.now().toString(36)}`;
  try {
    received.length = 0;
    await page.goto("/admin/chambres/new");
    await page.fill('[name="nom"]', name);
    await page.fill('[name="prix"]', "90");
    await page.fill('[name="capacite"]', "1");
    await page.click('[type="submit"]');
    await expect(page).toHaveURL("/admin/chambres");
    await page.waitForTimeout(1500); // l'envoi part après la réponse : on lui laisse le temps d'arriver
    expect(received).toHaveLength(0);
  } finally {
    await deleteRoomsByName(ctx.tenantId, name);
    await drizzle(pool).update(tenants).set({ domain: DOMAIN }).where(eq(tenants.id, ctx.tenantId));
  }
});

test("envoi initial : sans Authorization → 401 (ou 500 si CRON_SECRET absent)", async ({ request }) => {
  const res = await request.get("/api/cron/indexnow");
  expect([401, 500]).toContain(res.status());
  expect((await request.get("/api/cron/indexnow", { headers: { Authorization: "Bearer faux" } })).status()).not.toBe(200);
});

test("envoi initial : toutes les pages de l'hôtel + accueil vitrine", async ({ request }) => {
  const secret = process.env.CRON_SECRET;
  test.skip(!secret, "CRON_SECRET non configuré dans l'environnement de test");
  received.length = 0;
  const res = await request.get("/api/cron/indexnow", { headers: { Authorization: `Bearer ${secret}` } });
  expect(res.status()).toBe(200);
  const site = received.find((s) => s.host === DOMAIN);
  expect(site?.urlList).toEqual(expect.arrayContaining([`https://${DOMAIN}/`, `https://${DOMAIN}/chambres`, `https://${DOMAIN}/chambres/chambre-api-test`]));
  expect(received.find((s) => s.host === "directloc.localhost")?.urlList).toEqual(["https://directloc.localhost/"]);
});
