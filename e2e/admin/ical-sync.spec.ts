import { test, expect } from "@playwright/test";
import fs from "fs";
import http from "http";
import type { AddressInfo } from "net";
import path from "path";
import { eq } from "drizzle-orm";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { icalBlocks, icalSources } from "../../db/schema";

/**
 * Spécification : Tests de non-régression > Admin > Synchronisation iCal
 *
 * Une plateforme qui répond 200 avec une page HTML (erreur, maintenance, login)
 * ne doit pas être lue comme « plus aucune réservation » : sinon tous les blocs
 * importés sont effacés et la chambre paraît libre sur le site direct.
 *
 * Le flux est servi par un petit serveur local (ICAL_ALLOW_PRIVATE=1 côté webServer) :
 * d'abord un vrai calendrier, puis une page HTML en 200 (audit 2026-10b/07).
 */

const ctx = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "e2e", ".auth", "test-context.json"), "utf-8"),
) as { tenantId: string; apiRoomId: string };

const ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//test//html-guard//FR",
  "BEGIN:VEVENT",
  "UID:html-guard-test",
  "DTSTART;VALUE=DATE:20310310",
  "DTEND;VALUE=DATE:20310314",
  "SUMMARY:Réservé Airbnb",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");
const HTML = "<!DOCTYPE html><html><body><h1>Maintenance</h1></body></html>";

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL! });
const db = drizzle(pool);
let body = ICS;
const server = http.createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": body === ICS ? "text/calendar" : "text/html" });
  res.end(body);
});
let sourceId: string;

test.beforeAll(async () => {
  // Écoute IPv4+IPv6 : seul le nom `localhost` est exempté du garde anti-SSRF.
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  const [source] = await db
    .insert(icalSources)
    .values({
      tenantId: ctx.tenantId,
      roomId: ctx.apiRoomId,
      name: "Source HTML (test)",
      url: `http://localhost:${port}/feed.ics`,
    })
    .returning({ id: icalSources.id });
  sourceId = source.id;
});

test.afterAll(async () => {
  await db.delete(icalBlocks).where(eq(icalBlocks.sourceId, sourceId));
  await db.delete(icalSources).where(eq(icalSources.id, sourceId));
  await pool.end();
  server.close();
});

test("iCal : une réponse HTML en 200 n'efface pas les blocs déjà importés", async ({ page }) => {
  const blocks = () => db.select().from(icalBlocks).where(eq(icalBlocks.sourceId, sourceId));

  // 1. Flux valide : le bloc est importé.
  const first = await page.request.post("/api/admin/ical-sync");
  expect(first.ok()).toBeTruthy();
  expect(await blocks()).toHaveLength(1);

  // 2. La plateforme sert une page HTML en 200 : erreur signalée, bloc conservé.
  body = HTML;
  const second = await page.request.post("/api/admin/ical-sync");
  expect(second.ok()).toBeTruthy();
  expect((await second.json()).errors).toBe((await first.json()).errors + 1);
  expect(await blocks()).toHaveLength(1);
});
