import { test, expect, type Page } from "@playwright/test";
import fs from "fs";
import path from "path";
import sharp from "sharp";
import { Pool } from "pg";

/**
 * Spécification : Tests de non-régression > Admin > Icône d'onglet (favicon) et
 * lien « Voir mon site ».
 */

const ctx = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "e2e", ".auth", "test-context.json"), "utf-8"),
) as { tenantId: string; apiRoomId: string };

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });

const png = (w: number, h: number) =>
  sharp({ create: { width: w, height: h, channels: 4, background: { r: 200, g: 60, b: 40, alpha: 1 } } }).png().toBuffer();

async function storedFavicon(): Promise<{ filename: string; url: string } | null> {
  const { rows } = await pool.query("SELECT config->'favicon' AS f FROM tenants WHERE id = $1", [ctx.tenantId]);
  return rows[0].f ?? null;
}

const iconHrefs = (page: Page) =>
  page.locator('head link[rel~="icon"]').evaluateAll((ls) => ls.map((l) => l.getAttribute("href")));

async function openSiteTab(page: Page) {
  await page.goto("/admin/parametres?tab=site");
  await expect(page.getByRole("heading", { name: "Icône d'onglet" })).toBeVisible();
}

test.describe("Admin — icône d'onglet du site", () => {
  test.beforeAll(async () => {
    await pool.query("UPDATE tenants SET config = config - 'favicon' WHERE id = $1", [ctx.tenantId]);
  });
  test.afterAll(async () => {
    await pool.query("UPDATE tenants SET config = config - 'favicon' WHERE id = $1", [ctx.tenantId]);
    await pool.end();
  });

  test("sans icône : le site garde l'icône par défaut", async ({ page }) => {
    await page.goto("/");
    expect((await iconHrefs(page)).some((h) => h?.startsWith("/favicon.ico"))).toBe(true);
  });

  test("l'admin porte l'icône DirectLoc, pas l'icône neutre des sites d'hôtel", async ({ page }) => {
    await page.goto("/admin");
    const hrefs = await iconHrefs(page);
    expect(hrefs).toContain("/brand/favicon.ico");
    expect(hrefs.some((h) => h?.startsWith("/favicon.ico"))).toBe(false);
    // Logo de la barre latérale : la maison-almanach, un seul jour réservé.
    await expect(page.locator('aside svg[aria-hidden="true"] rect[fill="#c41f27"]').first()).toBeAttached();
  });

  test("envoyer une icône rectangulaire : recadrée en carré 512 px, affichée dans l'onglet du site, retirable", async ({ page }) => {
    await openSiteTab(page);
    await page.getByTestId("favicon-input").setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: await png(800, 300) });
    await expect(page.getByText("Icône enregistrée.")).toBeVisible();
    await expect(page.getByTestId("favicon-preview").locator("img")).toBeVisible();

    const fav = await storedFavicon();
    expect(fav?.url).toMatch(/favicon-[0-9a-f-]+\.png$/);
    const file = await page.request.get(fav!.url);
    expect(file.status()).toBe(200);
    expect(file.headers()["content-type"]).toContain("image/png");
    const meta = await sharp(await file.body()).metadata();
    expect([meta.width, meta.height]).toEqual([512, 512]);

    // Site public : accueil, chambres et tunnel de réservation portent l'icône de l'hôtel.
    for (const url of ["/", "/chambres", `/reserver/${ctx.apiRoomId}`]) {
      await page.goto(url);
      const hrefs = await iconHrefs(page);
      expect(hrefs, url).toContain(fav!.url);
      expect(hrefs.some((h) => h?.startsWith("/favicon.ico")), url).toBe(false);
    }

    // Remplacer : l'ancien fichier est supprimé.
    await openSiteTab(page);
    await page.getByTestId("favicon-input").setInputFiles({ name: "b.png", mimeType: "image/png", buffer: await png(64, 64) });
    await expect(page.getByText("Icône enregistrée.")).toBeVisible();
    const next = await storedFavicon();
    expect(next?.url).not.toBe(fav!.url);
    expect((await page.request.get(fav!.url)).status()).toBe(404);

    // Retirer : retour à l'icône par défaut.
    await page.getByRole("button", { name: "Retirer" }).click();
    await expect(page.getByText("Icône retirée.")).toBeVisible();
    expect(await storedFavicon()).toBeNull();
    expect((await page.request.get(next!.url)).status()).toBe(404);
    await page.goto("/");
    expect((await iconHrefs(page)).some((h) => h?.startsWith("/favicon.ico"))).toBe(true);
  });

  test("refus : SVG, fichier illisible, trop lourd → message, rien d'enregistré", async ({ page }) => {
    const post = (name: string, mimeType: string, buffer: Buffer) =>
      page.request.post("/api/admin/favicon", { multipart: { favicon: { name, mimeType, buffer } } });

    const svg = await post("x.svg", "image/svg+xml", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'));
    expect(svg.status()).toBe(400);
    expect((await svg.json()).error).toContain("PNG, JPEG ou WebP");

    const fake = await post("faux.png", "image/png", Buffer.from("pas une image"));
    expect(fake.status()).toBe(400);
    expect((await fake.json()).error).toBe("Image illisible");

    const big = await post("gros.png", "image/png", Buffer.alloc(2 * 1024 * 1024 + 1));
    expect(big.status()).toBe(400);
    expect((await big.json()).error).toContain("2 Mo");

    const none = await page.request.post("/api/admin/favicon", { multipart: { autre: "x" } });
    expect(none.status()).toBe(400);

    expect(await storedFavicon()).toBeNull();
  });

  test("message d'erreur affiché dans l'admin pour un fichier refusé", async ({ page }) => {
    await openSiteTab(page);
    await page.getByTestId("favicon-input").setInputFiles({ name: "faux.png", mimeType: "image/png", buffer: Buffer.from("rien") });
    await expect(page.getByText("Image illisible")).toBeVisible();
  });
});

test.describe("Admin — Voir mon site", () => {
  test("lien dans la barre latérale et dans l'onglet Mon site : ouvre l'accueil dans un nouvel onglet", async ({ page }) => {
    await page.goto("/admin");
    const link = page.getByTestId("view-site-link").filter({ visible: true });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", "/");
    await expect(link).toHaveAttribute("target", "_blank");
    const [popup] = await Promise.all([page.waitForEvent("popup"), link.click()]);
    await popup.waitForLoadState();
    await expect(popup.locator(".site")).toBeVisible();
    await popup.close();

    await page.goto("/admin/parametres?tab=site");
    await expect(page.getByTestId("site-tab-view-link")).toHaveAttribute("href", "/");
  });
});

test.describe("Sans session", () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  test("envoyer ou retirer une icône sans être connecté → 401", async ({ request }) => {
    expect((await request.post("/api/admin/favicon", { multipart: { favicon: { name: "a.png", mimeType: "image/png", buffer: Buffer.from("x") } } })).status()).toBe(401);
    expect((await request.delete("/api/admin/favicon")).status()).toBe(401);
  });
});
