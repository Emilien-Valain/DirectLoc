import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import crypto from "crypto";
import fs from "fs";
import http from "http";
import path from "path";
import zlib from "zlib";
import type { AddressInfo } from "net";
import { eq } from "drizzle-orm";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { bookings, dossiers, icalSources, payments } from "../../db/schema";
import { startPosthogSink } from "../helpers/posthog-sink";
import { startSmtpSink } from "../helpers/smtp-sink";

/**
 * Spécification : Tests de non-régression > Mesure d'audience (PostHog)
 * Lancé par `npm run test:analytics` (serveur avec POSTHOG_KEY=phc_test, faux PostHog sur :3998).
 */

const SITE = "http://localhost:3001";
const VITRINE = "http://directloc.localhost:3001";
const DEMO = "http://demo-tenant.localhost:3001";
const PH_COOKIE = "ph_phc_test_posthog";

const ctx = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "e2e", ".auth", "test-context.json"), "utf-8"),
) as { tenantId: string; apiRoomId: string };

// IP propre au spec : rappel limité à 5 / h / IP, /essayer à 20 / min.
test.use({ extraHTTPHeaders: { "x-forwarded-for": `10.30.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` } });
test.describe.configure({ mode: "serial" });

let sink: Awaited<ReturnType<typeof startPosthogSink>>;
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL! });
const db = drizzle(pool);

test.beforeAll(async () => {
  sink = await startPosthogSink();
});
test.afterAll(async () => {
  await sink.stop();
  await pool.query("DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email = 'demo@demo.local')");
  await pool.end();
});
// Le SDK navigateur ne sort jamais de la machine : chargement et envois interceptés.
test.beforeEach(async ({ context }) => {
  await context.route(/posthog\.com/, (r) => r.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
});

const banner = (page: Page) => page.getByTestId("consent-banner");
const phCookie = async (context: BrowserContext) => (await context.cookies()).find((c) => c.name === PH_COOKIE);

test("CSP : aucun appel PostHog bloqué (scripts, envois, worker du replay)", async ({ page }) => {
  const violations: string[] = [];
  page.on("console", (m) => /Content Security Policy/.test(m.text()) && violations.push(m.text()));
  for (const url of [`${SITE}/`, `${VITRINE}/`]) {
    await page.goto(url);
    await banner(page).getByRole("button", { name: "Accepter" }).click();
    await page.waitForTimeout(1500);
  }
  expect(violations).toEqual([]);
});

test.describe("Bandeau de consentement", () => {
  test("site client : Refuser → aucun cookie PostHog, choix mémorisé", async ({ page, context }) => {
    await page.goto(`${SITE}/`);
    await expect(banner(page)).toBeVisible();
    expect(await phCookie(context)).toBeUndefined(); // rien avant le choix
    await banner(page).getByRole("button", { name: "Refuser" }).click();
    await expect(banner(page)).toHaveCount(0);
    await page.reload();
    await page.waitForTimeout(1000);
    await expect(banner(page)).toHaveCount(0);
    expect(await phCookie(context)).toBeUndefined();
  });

  test("site client : Accepter → cookie PostHog posé, bandeau disparu", async ({ page, context }) => {
    await page.goto(`${SITE}/`);
    await banner(page).getByRole("button", { name: "Accepter" }).click();
    await expect(banner(page)).toHaveCount(0);
    await expect.poll(async () => (await phCookie(context)) !== undefined).toBe(true);
  });

  test("vitrine : Refuser et Accepter ont le même poids visuel", async ({ page }) => {
    await page.goto(`${VITRINE}/`);
    await expect(banner(page)).toBeVisible();
    const style = (name: string) =>
      banner(page).getByRole("button", { name }).evaluate((el) => {
        const s = getComputedStyle(el);
        return [s.backgroundColor, s.color, s.borderColor, s.fontWeight, s.fontSize, el.getBoundingClientRect().height].join("|");
      });
    expect(await style("Refuser")).toBe(await style("Accepter"));
  });

  test("lien « En savoir plus » vers /confidentialite", async ({ page }) => {
    await page.goto(`${SITE}/`);
    await expect(banner(page).getByRole("link", { name: "En savoir plus" })).toHaveAttribute("href", "/confidentialite");
  });
});

test.describe("Admin", () => {
  test.use({ storageState: "e2e/.auth/admin.json" });

  test("pas de bandeau ni de cookie PostHog dans l'admin", async ({ page, context }) => {
    await page.goto(`${SITE}/admin`);
    await expect(page.getByRole("heading").first()).toBeVisible();
    await page.waitForTimeout(1000);
    await expect(banner(page)).toHaveCount(0);
    expect(await phCookie(context)).toBeUndefined();
  });

  test("annulation → booking_cancelled avec from_status, rattaché à l'hébergeur", async ({ page }) => {
    const day = (n: number) => new Date(Date.UTC(2031, 5, n));
    const [d] = await db
      .insert(dossiers)
      .values({ tenantId: ctx.tenantId, guestName: "PostHog Annul", guestEmail: "ph-annul@example.com", checkIn: day(10), checkOut: day(12) })
      .returning({ id: dossiers.id });
    const [b] = await db
      .insert(bookings)
      .values({
        tenantId: ctx.tenantId, dossierId: d.id, roomId: ctx.apiRoomId, guestName: "PostHog Annul", guestEmail: "ph-annul@example.com",
        checkIn: day(10), checkOut: day(12), status: "confirmed", totalPrice: "200",
      })
      .returning({ id: bookings.id });
    try {
      await page.goto(`${SITE}/admin/reservations/${b.id}`);
      await page.getByRole("button", { name: "Annuler" }).click();
      await page.locator("dialog[open] [data-confirm]").click();
      await expect(page).toHaveURL(/annulee=/);
      await expect.poll(() => sink.find("booking_cancelled").length).toBe(1);
      const e = sink.find("booking_cancelled")[0];
      expect(e.properties).toMatchObject({ surface: "admin", tenant_id: ctx.tenantId, from_status: "confirmed" });
      expect(e.properties.$process_person_profile).toBeUndefined(); // hébergeur identifié
      // Double annulation (page périmée) : aucun second événement.
      await page.goto(`${SITE}/admin/reservations/${b.id}`);
      await expect(page.getByRole("button", { name: "Annuler" })).toHaveCount(0);
      expect(sink.find("booking_cancelled").length).toBe(1);
    } finally {
      await db.delete(bookings).where(eq(bookings.id, b.id));
      await db.delete(dossiers).where(eq(dossiers.id, d.id));
    }
  });

  test("sync iCal en échec → ical_sync_failed catégorisé, sans URL", async ({ page }) => {
    const feed = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
    await new Promise<void>((r) => feed.listen(0, r));
    const url = `http://localhost:${(feed.address() as AddressInfo).port}/secret-token.ics`;
    const [src] = await db
      .insert(icalSources)
      .values({ tenantId: ctx.tenantId, roomId: ctx.apiRoomId, name: "PostHog 404 (test)", url })
      .returning({ id: icalSources.id });
    try {
      const before = sink.find("ical_sync_failed").length;
      expect((await page.request.post(`${SITE}/api/admin/ical-sync`)).ok()).toBe(true);
      await expect.poll(() => sink.find("ical_sync_failed").length).toBeGreaterThan(before);
      const e = sink.find("ical_sync_failed").at(-1)!;
      expect(e.properties).toMatchObject({ tenant_id: ctx.tenantId, error_category: "http_error" });
      expect(JSON.stringify(e)).not.toContain("secret-token");
    } finally {
      await db.delete(icalSources).where(eq(icalSources.id, src.id));
      feed.close();
    }
  });
});

test.describe("Vitrine : partenaires et rappel", () => {
  const form = (page: Page) => page.locator("form.alm-coupon").first();
  const submit = async (page: Page) => {
    await form(page).getByLabel("Nom").fill("Jeanne Partenaire");
    await form(page).getByLabel("Téléphone").fill("06 12 34 56 78");
    await form(page).getByRole("button", { name: "Être rappelé" }).click();
    await expect(form(page).getByRole("status")).toContainText("C'est noté");
  };

  test("?ref valide + consentement → callback_requested rattaché au visiteur, ref dans l'e-mail", async ({ page, context }) => {
    const mails = await startSmtpSink();
    try {
      await page.goto(`${VITRINE}/?ref=agence-42`);
      await banner(page).getByRole("button", { name: "Accepter" }).click();
      await expect.poll(async () => (await phCookie(context)) !== undefined).toBe(true);
      const distinctId = JSON.parse(decodeURIComponent((await phCookie(context))!.value)).distinct_id;
      const before = sink.find("callback_requested").length;
      await submit(page);
      await expect.poll(() => sink.find("callback_requested").length).toBe(before + 1);
      const e = sink.find("callback_requested").at(-1)!;
      expect(e.distinct_id).toBe(distinctId);
      expect(e.properties).toMatchObject({ surface: "vitrine", partner_code: "agence-42" });
      await expect.poll(() => mails.mails.length).toBe(1);
      expect(mails.mails[0].raw).toContain("agence-42");
    } finally {
      await mails.stop();
    }
  });

  test("?ref malformé (XSS) → ignoré partout, la demande passe quand même", async ({ page }) => {
    const mails = await startSmtpSink();
    let dialog = false;
    page.on("dialog", (d) => { dialog = true; void d.dismiss(); });
    try {
      await page.goto(`${VITRINE}/?ref=${encodeURIComponent("<script>alert(1)</script>")}`);
      const before = sink.find("callback_requested").length;
      await submit(page);
      await expect.poll(() => sink.find("callback_requested").length).toBe(before + 1);
      const e = sink.find("callback_requested").at(-1)!;
      expect(e.properties.partner_code).toBeUndefined();
      expect(e.properties.$process_person_profile).toBe(false); // pas de consentement → anonyme
      await expect.poll(() => mails.mails.length).toBe(1);
      expect(mails.mails[0].raw).not.toContain("(ref)");
      expect(dialog).toBe(false);
    } finally {
      await mails.stop();
    }
  });

  test("lien « Essayer l'admin » depuis la vitrine ?ref → demo_opened avec partner_code", async ({ page }) => {
    await page.goto(`${VITRINE}/?ref=gite-de-france`);
    const before = sink.find("demo_opened").length;
    await page.getByRole("link", { name: "Essayer l'admin avec un compte de démonstration" }).first().click();
    await expect(page).toHaveURL(`${DEMO}/admin`);
    await expect.poll(() => sink.find("demo_opened").length).toBe(before + 1);
    expect(sink.find("demo_opened").at(-1)!.properties).toMatchObject({ partner_code: "gite-de-france" });
  });
});

test.describe("Vitrine : clics sur les boutons (cta_clicked)", () => {
  type PhEvent = { event: string; properties: Record<string, unknown> };

  /** Enregistre les événements envoyés par le SDK navigateur (JSON, base64 ou gzip, fetch ou beacon). */
  async function recordBrowserEvents(page: Page) {
    const events: PhEvent[] = [];
    // posthog-js écarte les robots : navigateur piloté (navigator.webdriver) et marque « HeadlessChrome ».
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
      Object.defineProperty(navigator, "userAgentData", { get: () => undefined });
    });
    await page.route(/posthog\.com/, async (route) => {
      const req = route.request();
      const raw = req.postDataBuffer();
      if (raw?.length) {
        try {
          let text: string;
          if (/compression=gzip/.test(req.url())) text = zlib.gunzipSync(raw).toString();
          else {
            text = raw.toString();
            const data = new URLSearchParams(text).get("data");
            if (data && !text.trimStart().startsWith("{") && !text.trimStart().startsWith("[")) {
              text = Buffer.from(data, "base64").toString();
            }
          }
          const parsed = JSON.parse(text);
          const list = Array.isArray(parsed) ? parsed : (parsed.batch ?? [parsed]);
          for (const e of list) if (e?.event) events.push(e);
        } catch {
          // requêtes sans événement (flags, config) : ignorées
        }
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });
    const clicks = (cta: string) => events.filter((e) => e.event === "cta_clicked" && e.properties.cta === cta);
    return Object.assign(clicks, { pageviews: () => events.filter((e) => e.event === "$pageview") });
  }

  test("« Être rappelé » du menu après Refuser → cta_clicked rappel/menu (anonyme, sans cookie)", async ({ page, context }) => {
    const clicks = await recordBrowserEvents(page);
    await page.goto(`${VITRINE}/`);
    await banner(page).getByRole("button", { name: "Refuser" }).click();
    await page.locator("nav").getByRole("link", { name: "Être rappelé" }).click();
    await expect.poll(() => clicks("rappel").length).toBe(1);
    expect(clicks("rappel")[0].properties).toMatchObject({ placement: "menu", surface: "vitrine" });
    expect(await phCookie(context)).toBeUndefined();
  });

  test("sans réponse au bandeau → page vue et clic comptés sans cookie, bandeau toujours là après rechargement", async ({ page, context }) => {
    const clicks = await recordBrowserEvents(page);
    await page.goto(`${VITRINE}/`);
    await expect(banner(page)).toBeVisible();
    await expect.poll(() => clicks.pageviews().length).toBeGreaterThan(0);
    await page.locator("nav").getByRole("link", { name: "Être rappelé" }).click();
    await expect.poll(() => clicks("rappel").length).toBe(1);
    expect(clicks("rappel")[0].properties).toMatchObject({ placement: "menu", surface: "vitrine" });
    expect(await phCookie(context)).toBeUndefined();
    await page.reload();
    await expect(banner(page)).toBeVisible(); // le refus posé d'office n'est pas un choix
    expect(await phCookie(context)).toBeUndefined();
  });

  test("sans réponse puis Accepter → cookie posé, bandeau disparu même après rechargement", async ({ page, context }) => {
    await recordBrowserEvents(page);
    await page.goto(`${VITRINE}/`);
    await banner(page).getByRole("button", { name: "Accepter" }).click();
    await expect.poll(async () => (await phCookie(context)) !== undefined).toBe(true);
    await page.reload();
    await page.waitForTimeout(1000);
    await expect(banner(page)).toHaveCount(0);
  });

  test("« Essayer l'admin » du haut → cta_clicked envoyé malgré le changement de page", async ({ page }) => {
    const clicks = await recordBrowserEvents(page);
    await page.goto(`${VITRINE}/`);
    await banner(page).getByRole("button", { name: "Accepter" }).click();
    await page.getByRole("link", { name: "Essayer l'admin avec un compte de démonstration" }).first().click();
    await expect(page).toHaveURL(`${DEMO}/admin`);
    await expect.poll(() => clicks("essayer").length).toBe(1);
    expect(clicks("essayer")[0].properties).toMatchObject({ placement: "haut", surface: "vitrine" });
  });

  test("clic hors bouton marqué (lien d'ancre « Tarifs ») → aucun cta_clicked", async ({ page }) => {
    const clicks = await recordBrowserEvents(page);
    await page.goto(`${VITRINE}/`);
    await banner(page).getByRole("button", { name: "Accepter" }).click();
    await page.locator("nav").getByRole("link", { name: "Tarifs" }).click();
    await page.waitForTimeout(1500);
    expect([...clicks("rappel"), ...clicks("essayer"), ...clicks("site_demo")]).toHaveLength(0);
  });
});

test.describe("Paiement", () => {
  // La création de la session Stripe n'est pas simulée en test (clé placeholder) : l'action échoue avant l'événement.
  test.skip("formulaire public → booking_submitted (nights, amount_bucket) et posthogDistinctId dans les métadonnées Stripe", () => {});

  const sign = (payload: string) => {
    const t = Math.floor(Date.now() / 1000);
    const secret = process.env.STRIPE_WEBHOOK_SECRET ?? "whsec_test_XXXX";
    return `t=${t},v1=${crypto.createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex")}`;
  };

  test("webhook checkout.session.completed → booking_paid avec le distinct_id relayé, une seule fois", async ({ request }) => {
    const sessionId = `cs_test_posthog_${Date.now()}`;
    const [d] = await db
      .insert(dossiers)
      .values({ tenantId: ctx.tenantId, guestName: "PostHog Paid", guestEmail: "ph-paid@example.com", checkIn: new Date(Date.UTC(2031, 6, 1)), checkOut: new Date(Date.UTC(2031, 6, 3)) })
      .returning({ id: dossiers.id });
    const [b] = await db
      .insert(bookings)
      .values({
        tenantId: ctx.tenantId, dossierId: d.id, roomId: ctx.apiRoomId, guestName: "PostHog Paid", guestEmail: "ph-paid@example.com",
        checkIn: new Date(Date.UTC(2031, 6, 1)), checkOut: new Date(Date.UTC(2031, 6, 3)), status: "pending", totalPrice: "300",
      })
      .returning({ id: bookings.id });
    await db.insert(payments).values({ tenantId: ctx.tenantId, dossierId: d.id, stripeSessionId: sessionId, amount: "300", currency: "eur", status: "pending" });
    try {
      const payload = JSON.stringify({
        id: `evt_test_ph_${Date.now()}`,
        type: "checkout.session.completed",
        data: { object: { id: sessionId, payment_intent: "pi_test_ph", metadata: { dossierId: d.id, tenantId: ctx.tenantId, posthogDistinctId: "visiteur-123" } } },
      });
      const post = () => request.post(`${SITE}/api/webhooks/stripe`, {
        data: payload,
        headers: { "content-type": "application/json", "stripe-signature": sign(payload) },
      });
      const before = sink.find("booking_paid").length;
      expect((await post()).status()).toBe(200);
      await expect.poll(() => sink.find("booking_paid").length).toBe(before + 1);
      const e = sink.find("booking_paid").at(-1)!;
      expect(e.distinct_id).toBe("visiteur-123");
      expect(e.properties).toMatchObject({ surface: "tenant_site", tenant_id: ctx.tenantId });
      // Stripe relivre l'événement : pas de second booking_paid.
      expect((await post()).status()).toBe(200);
      await new Promise((r) => setTimeout(r, 1000));
      expect(sink.find("booking_paid").length).toBe(before + 1);
    } finally {
      await db.delete(payments).where(eq(payments.dossierId, d.id));
      await db.delete(bookings).where(eq(bookings.id, b.id));
      await db.delete(dossiers).where(eq(dossiers.id, d.id));
    }
  });
});
