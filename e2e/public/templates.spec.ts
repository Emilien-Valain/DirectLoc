import fs from "fs";
import path from "path";
import { Pool } from "pg";
import { test, expect } from "@playwright/test";
import { fd } from "../helpers/dates";

/**
 * Spécification : Tests de non-régression > Public > Templates
 *
 * Source de vérité : `Tests de non-régression.md`
 *
 * Les quatre templates partagent le même balisage ; chaque univers vit dans sa
 * feuille CSS scopée par [data-tpl]. On vérifie pour chacun que le parcours
 * de réservation reste complet, et qu'aucun contenu non renseigné par l'hôte
 * n'est inventé sur le site public.
 */

const TEMPLATES = [
  { key: "classic", tpl: "plaque" },
  { key: "boutique", tpl: "linge" },
  { key: "affiche", tpl: "affiche" },
  { key: "standard", tpl: "standard" },
] as const;

function loadTestContext() {
  const contextPath = path.join(process.cwd(), "e2e", ".auth", "test-context.json");
  return JSON.parse(fs.readFileSync(contextPath, "utf-8")) as {
    tenantId: string;
    apiRoomId: string;
  };
}

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
let originalConfig: Record<string, unknown> = {};

async function setConfig(patch: Record<string, unknown>) {
  const { tenantId } = loadTestContext();
  await pool.query("UPDATE tenants SET config = config || $1::jsonb WHERE id = $2", [
    JSON.stringify(patch),
    tenantId,
  ]);
}

test.describe("Public — templates", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    const { tenantId } = loadTestContext();
    const { rows } = await pool.query("SELECT config FROM tenants WHERE id = $1", [tenantId]);
    originalConfig = rows[0].config;
  });

  test.afterAll(async () => {
    const { tenantId } = loadTestContext();
    await pool.query("UPDATE tenants SET config = $1::jsonb WHERE id = $2", [
      JSON.stringify(originalConfig),
      tenantId,
    ]);
    await pool.end();
  });

  for (const { key, tpl } of TEMPLATES) {
    test(`${key} → univers « ${tpl} » : accueil, chambres, réservation`, async ({ page }) => {
      await setConfig({ template: key });
      const { apiRoomId } = loadTestContext();

      await page.goto("/");
      await expect(page.locator(`.site[data-tpl="${tpl}"]`)).toBeVisible();
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(page.getByRole("button", { name: "Voir les disponibilités" })).toBeVisible();
      await expect(page.getByRole("link", { name: /Chambre API Test/ }).first()).toBeVisible();

      await page.goto("/chambres");
      await expect(page.getByRole("heading", { level: 1, name: "Nos chambres" })).toBeVisible();

      await page.goto(`/reserver/${apiRoomId}`);
      await expect(page.getByRole("heading", { level: 1 })).toContainText("Réserver");
      await expect(page.getByTestId("booking-summary")).toBeVisible();
      await expect(page.getByTestId("booking-submit")).toBeVisible();
    });
  }

  // Régression : en affiche, les résultats de recherche héritaient du texte papier du bandeau (papier sur papier).
  for (const { key } of TEMPLATES) {
    test(`${key} : les chambres trouvées par la recherche de l'accueil sont lisibles`, async ({ page }) => {
      await setConfig({ template: key });
      await page.goto("/");
      await expect(async () => {
        await page.fill("#search-checkin", fd("2026-09-21"));
        await page.fill("#search-checkout", fd("2026-09-23"));
        await page.getByRole("button", { name: "Voir les disponibilités" }).click();
        await expect(page.locator(".s-search-room").first()).toBeVisible({ timeout: 2000 });
      }).toPass({ timeout: 15_000 });
      const [fg, bg] = await page.locator(".s-search-room").first().evaluate((el) => {
        const cs = getComputedStyle(el);
        return [cs.color, cs.backgroundColor];
      });
      expect(fg).not.toBe(bg);
    });
  }

  // Régression : le fond mélangeait la couleur secondaire de l'hôte sans borne ; un orange vif
  // faisait tomber le texte gris sous 4.5:1. Couleurs « hostiles » : primaire grise, secondaire orange.
  for (const { key } of TEMPLATES) {
    test(`${key} : texte secondaire lisible même avec une couleur d'hôte saturée`, async ({ page }) => {
      await setConfig({ template: key, primaryColor: "#5e5c64", secondaryColor: "#e66100" });
      await page.goto("/");
      const pairs: [string, string][] = [["var(--s-ink-soft)", "var(--s-ground)"]];
      if (key === "standard") pairs.push(["#fff", "color-mix(in oklch, var(--st-brand) 85%, #fff)"]);
      const ratios = await page.locator(".site").evaluate((site, pairs) => {
        // Résout une couleur CSS (variables, oklch relatif, color-mix) en sRGB via un canvas.
        const probe = document.createElement("div");
        site.appendChild(probe);
        const ctx = document.createElement("canvas").getContext("2d")!;
        const rgb = (css: string) => {
          probe.style.color = css;
          ctx.clearRect(0, 0, 1, 1);
          ctx.fillStyle = getComputedStyle(probe).color;
          ctx.fillRect(0, 0, 1, 1);
          return Array.from(ctx.getImageData(0, 0, 1, 1).data.slice(0, 3));
        };
        const lum = (c: number[]) => {
          const [r, g, b] = c.map((v) => {
            const x = v / 255;
            return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
          });
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        const out = pairs.map(([fg, bg]) => {
          const [a, b] = [lum(rgb(fg)), lum(rgb(bg))].sort((x, y) => y - x);
          return (a + 0.05) / (b + 0.05);
        });
        probe.remove();
        return out;
      }, pairs);
      for (const r of ratios) expect(r).toBeGreaterThanOrEqual(4.5);
      await setConfig({ primaryColor: originalConfig.primaryColor ?? null, secondaryColor: originalConfig.secondaryColor ?? null });
    });
  }

  test("aucune donnée inventée : horaires, accès et adresse absents s'ils ne sont pas renseignés", async ({ page }) => {
    // Le tenant de test n'a ni checkInTime, ni accessLines.
    await setConfig({ template: "classic" });
    await page.goto("/");
    const body = page.locator("body");
    await expect(body).not.toContainText("Parking gratuit");
    await expect(body).not.toContainText("15h");
    await expect(body).not.toContainText("à renseigner");
    await expect(body).not.toContainText("Boutique Hôtel");
    await expect(page.locator("#nous-trouver")).not.toContainText("Horaires");
  });

  test("sans adresse ni contact ni carte : pas de section ni de lien « Nous trouver »", async ({ page }) => {
    await setConfig({
      template: "standard",
      address: null,
      phone: null,
      email: null,
      latitude: null,
      longitude: null,
      googleMapsUrl: null,
    });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await expect(page.locator("#nous-trouver")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Nous trouver", exact: true })).toHaveCount(0);
    // Restaure les coordonnées pour les tests suivants
    await setConfig({
      address: originalConfig.address,
      phone: originalConfig.phone,
      email: originalConfig.email,
      latitude: originalConfig.latitude,
      longitude: originalConfig.longitude,
    });
  });

  test("affiche : la photo de l'hôte remplace le paysage dessiné, le dessin reste le repli", async ({ page }) => {
    await setConfig({ template: "affiche", heroPhoto: null });
    // Mesure de mise en page : sans l'animation d'entrée du hero (translateY pendant 0,6 s).
    await page.emulateMedia({ reducedMotion: "reduce" });
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto("/");
      await expect(page.locator(".s-hero-art")).toBeVisible();
      await expect(page.locator(".s-hero-photo")).toHaveCount(0);
    }
    await setConfig({ heroPhoto: { id: "x", url: "/api/uploads/inexistant.webp", filename: "inexistant.webp" } });
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto("/");
      await expect(page.locator(".s-hero-art")).toBeHidden();
      const photo = page.locator(".s-hero-photo");
      await expect(photo).toBeVisible();
      // Pleine largeur, entre le titre et la réservation.
      const box = (await photo.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(width - 20);
      expect(box.height).toBeGreaterThan(200);
      const titleBottom = (await page.locator(".s-namecard").boundingBox())!;
      const search = (await page.locator(".s-search").boundingBox())!;
      expect(box.y).toBeGreaterThanOrEqual(titleBottom.y + titleBottom.height - 1);
      expect(box.y + box.height).toBeLessThanOrEqual(search.y + 1);
    }
    await setConfig({ heroPhoto: originalConfig.heroPhoto ?? null });
  });

  test("réservation : aucune date pré-remplie, donc aucune erreur à l'arrivée", async ({ page }) => {
    await setConfig({ template: "affiche" });
    const { apiRoomId } = loadTestContext();
    await page.goto(`/reserver/${apiRoomId}`);
    await page.waitForLoadState("networkidle");
    await expect(page.locator('[name="checkIn"]')).toHaveValue("");
    await expect(page.locator('[name="checkOut"]')).toHaveValue("");
    await expect(page.getByText("Non disponible pour ces dates")).toHaveCount(0);
    await expect(page.getByTestId("booking-submit")).toBeDisabled();
    await expect(page.getByTestId("booking-summary-total")).toHaveText("—");
  });

  test("XSS : un titre d'accueil malveillant est rendu comme du texte", async ({ page }) => {
    let dialog = false;
    page.on("dialog", (d) => {
      dialog = true;
      void d.dismiss();
    });
    await setConfig({ template: "boutique", heroTitle: "<script>alert(1)</script>" });
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("<script>alert(1)</script>");
    expect(dialog).toBe(false);
    await setConfig({ heroTitle: null });
  });

  test("template inconnu en base : retombe sur la Plaque émaillée, jamais de 500", async ({ page }) => {
    await setConfig({ template: "inexistant" });
    const res = await page.goto("/");
    expect(res?.status()).toBe(200);
    await expect(page.locator('.site[data-tpl="plaque"]')).toBeVisible();
  });

  test("couleur primaire très claire : le texte des plaques reste lisible (émail assombri)", async ({ page }) => {
    await setConfig({ template: "classic", primaryColor: "#FFF3B0" });
    await page.goto("/");
    const bg = await page
      .locator(".s-namecard")
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    // oklch(L …) : la clarté est plafonnée à 0.42 pour garder le blanc lisible
    const l = Number(bg.match(/oklch\(([\d.]+)/)?.[1] ?? "1");
    expect(l).toBeLessThanOrEqual(0.43);
  });
});
