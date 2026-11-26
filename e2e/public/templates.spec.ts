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
 * Les templates partagent le même balisage ; chaque univers vit dans sa
 * feuille CSS scopée par [data-tpl]. Le Carnet a en plus son propre accueil et
 * son en-tête (templates/Carnet.tsx), comme le Guide du parc
 * (templates/Guide.tsx), le Défilant (Defilant.tsx) et la Carte postale (Postale.tsx). On vérifie pour chacun que le parcours
 * de réservation reste complet, et qu'aucun contenu non renseigné par l'hôte
 * n'est inventé sur le site public.
 */

const TEMPLATES = [
  { key: "classic", tpl: "plaque", searchBtn: "Voir les disponibilités" },
  { key: "boutique", tpl: "linge", searchBtn: "Voir les disponibilités" },
  { key: "affiche", tpl: "affiche", searchBtn: "Voir les disponibilités" },
  { key: "standard", tpl: "standard", searchBtn: "Voir les disponibilités" },
  { key: "carnet", tpl: "carnet", searchBtn: "Vérifier les dates" },
  { key: "guide", tpl: "guide", searchBtn: "Voir les disponibilités" },
  { key: "defilant", tpl: "defilant", searchBtn: "C'est parti →" },
  { key: "postale", tpl: "postale", searchBtn: "Envoyer la carte →" },
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

async function contrastRatios(page: import("@playwright/test").Page, pairs: Record<string, [string, string]>) {
  return page.locator(".site").evaluate((site, pairs) => {
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
    const out: Record<string, number> = {};
    for (const [k, [fg, bg]] of Object.entries(pairs)) {
      const [a, b] = [lum(rgb(fg)), lum(rgb(bg))].sort((x, y) => y - x);
      out[k] = (a + 0.05) / (b + 0.05);
    }
    probe.remove();
    return out;
  }, pairs);
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

  for (const { key, tpl, searchBtn } of TEMPLATES) {
    test(`${key} → univers « ${tpl} » : accueil, chambres, réservation`, async ({ page }) => {
      await setConfig({ template: key });
      const { apiRoomId } = loadTestContext();

      await page.goto("/");
      await expect(page.locator(`.site[data-tpl="${tpl}"]`)).toBeVisible();
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(page.getByRole("button", { name: searchBtn })).toBeVisible();
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
  for (const { key, searchBtn } of TEMPLATES) {
    test(`${key} : les chambres trouvées par la recherche de l'accueil sont lisibles`, async ({ page }) => {
      await setConfig({ template: key });
      await page.goto("/");
      await expect(async () => {
        await page.fill("#search-checkin", fd("2026-09-21"));
        await page.fill("#search-checkout", fd("2026-09-23"));
        await page.getByRole("button", { name: searchBtn }).click();
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
  // ── Le Carnet : accueil propre (Carnet.tsx) ────────────────────────────────
  test.describe("carnet", () => {
    const HERO = { id: "x", url: "/api/uploads/inexistant.webp", filename: "inexistant.webp" };

    test.afterEach(async () => {
      await setConfig({
        heroTitle: originalConfig.heroTitle ?? null,
        heroSubtitle: originalConfig.heroSubtitle ?? null,
        heroPhoto: originalConfig.heroPhoto ?? null,
        storyTitle: originalConfig.storyTitle ?? null,
        storyText: originalConfig.storyText ?? null,
        storyEyebrow: originalConfig.storyEyebrow ?? null,
        primaryColor: originalConfig.primaryColor ?? null,
        accessLines: originalConfig.accessLines ?? null,
      });
    });

    test("en-tête : nom au centre, nav et « Réserver » ; titre en deux lignes, la seconde en italique", async ({ page }) => {
      await setConfig({ template: "carnet", heroTitle: "Une bergerie dans le bocage" });
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto("/");
      const nav = page.getByRole("navigation", { name: "Navigation principale" });
      await expect(nav.getByRole("link", { name: "Chambres" })).toBeVisible();
      await expect(page.getByRole("link", { name: "Réserver", exact: true })).toHaveAttribute("href", "/#dates");
      const h1 = page.getByRole("heading", { level: 1 });
      await expect(h1).toHaveText("Une bergerie dans le bocage");
      await expect(h1.locator("em")).toHaveText("dans le bocage");
      // Retour à la ligne choisi par l'hôte : prioritaire sur la coupe automatique.
      await setConfig({ heroTitle: "Le Clos\ndes Hirondelles" });
      await page.goto("/");
      await expect(h1.locator("em")).toHaveText("des Hirondelles");
      // Titre d'un seul mot : pas de seconde ligne vide.
      await setConfig({ heroTitle: "Bergerie" });
      await page.goto("/");
      await expect(h1).toHaveText("Bergerie");
      await expect(h1.locator("em")).toHaveCount(0);
    });

    test("sans photo : l'accroche devient la citation ; avec photo : légende sous la photo", async ({ page }) => {
      await setConfig({ template: "carnet", heroPhoto: null, heroSubtitle: "Trois chambres et le bocage." });
      await page.goto("/");
      await expect(page.locator(".c-quote")).toHaveText("« Trois chambres et le bocage. »");
      await expect(page.locator(".c-hero-figure")).toHaveCount(0);

      await setConfig({ heroPhoto: HERO });
      await page.goto("/");
      await expect(page.locator(".c-quote")).toHaveCount(0);
      await expect(page.locator(".c-hero-figure figcaption")).toHaveText("Trois chambres et le bocage.");

      // Ni photo ni accroche : aucun bloc vide.
      await setConfig({ heroPhoto: null, heroSubtitle: null });
      await page.goto("/");
      await expect(page.locator(".c-quote, .c-hero-figure")).toHaveCount(0);
    });

    test("chambres : articles numérotés 01, cliquables vers la page chambre, sans photo ni description vide", async ({ page }) => {
      await setConfig({ template: "carnet" });
      await page.goto("/");
      const article = page.locator(".c-room").filter({ hasText: "Chambre API Test" });
      await expect(article).toBeVisible();
      await expect(page.locator(".c-room-num").first()).toHaveText("01");
      await expect(article).toContainText(/\d+ pers\./);
      await expect(article).toContainText("/ nuit");
      // Chambre de test sans photo ni description : l'article garde numéro + texte, aucun cadre vide.
      await expect(article.locator(".c-room-photo")).toHaveCount(0);
      await expect(article.locator(".c-room-desc")).toHaveCount(0);
      await article.click();
      await expect(page).toHaveURL(/\/chambres\/chambre-api-test$/);
    });

    test("La maison : absente (section et lien) sans histoire, présente avec lettrine et signature", async ({ page }) => {
      await setConfig({ template: "carnet", storyTitle: null, storyText: null, storyEyebrow: null });
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto("/");
      await expect(page.locator("#la-maison")).toHaveCount(0);
      await expect(page.getByRole("link", { name: "La maison" })).toHaveCount(0);

      await setConfig({ storyText: "Nous avons rouvert la bergerie.", storyEyebrow: "Claire et Antoine" });
      await page.goto("/");
      await expect(page.locator("#la-maison")).toBeVisible();
      await expect(page.getByRole("link", { name: "La maison" })).toHaveAttribute("href", "/#la-maison");
      await expect(page.locator(".c-signature")).toHaveText("— Claire et Antoine");
      const capColor = await page.locator(".c-story-text").evaluate((el) => getComputedStyle(el, "::first-letter").color);
      const textColor = await page.locator(".c-story-text").evaluate((el) => getComputedStyle(el).color);
      expect(capColor).not.toBe(textColor);
    });

    test("chiffres clés et carte de l'hôte restent affichés", async ({ page }) => {
      await setConfig({ template: "carnet" });
      await page.goto("/");
      await expect(page.locator("#chiffres-cles")).toContainText("1820");
      await expect(page.locator("#nous-trouver")).toContainText("84480 Bonnieux");
    });

    test("contraste : sur-titres, bouton et numéros lisibles même avec une couleur d'hôte très claire", async ({ page }) => {
      await setConfig({ template: "carnet", primaryColor: "#FFF3B0" });
      await page.goto("/");
      const ratios = await page.locator(".site").evaluate((site) => {
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
        const ratio = (fg: string, bg: string) => {
          const [a, b] = [lum(rgb(fg)), lum(rgb(bg))].sort((x, y) => y - x);
          return (a + 0.05) / (b + 0.05);
        };
        const out = {
          mutedOnPaper: ratio("var(--c-muted)", "var(--c-paper)"),
          mutedOnHover: ratio("var(--c-muted)", "var(--c-hover)"),
          whiteOnAccent: ratio("#fff", "var(--c-accent)"),
          accentOnPaper: ratio("var(--c-accent)", "var(--c-paper)"),
        };
        probe.remove();
        return out;
      });
      expect(ratios.mutedOnPaper).toBeGreaterThanOrEqual(4.5);
      expect(ratios.mutedOnHover).toBeGreaterThanOrEqual(4.5);
      expect(ratios.whiteOnAccent).toBeGreaterThanOrEqual(4.5);
      expect(ratios.accentOnPaper).toBeGreaterThanOrEqual(4.5);
    });

    test("téléphone : une colonne, encart réservation sous le titre, aucun débordement horizontal", async ({ page }) => {
      await setConfig({ template: "carnet", heroPhoto: HERO, heroSubtitle: "Trois chambres et le bocage." });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.setViewportSize({ width: 360, height: 800 });
      await page.goto("/");
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      const photo = (await page.locator(".c-hero-photo").boundingBox())!;
      const book = (await page.locator(".c-book").boundingBox())!;
      expect(book.y).toBeGreaterThanOrEqual(photo.y + photo.height);
      const rooms = page.locator(".c-room");
      if ((await rooms.count()) > 1) {
        const [a, b] = [(await rooms.nth(0).boundingBox())!, (await rooms.nth(1).boundingBox())!];
        expect(b.y).toBeGreaterThan(a.y);
      }
    });

    test("carnet d'adresses : « Lieu : durée » en colonnes, absent sans lignes d'accès", async ({ page }) => {
      await setConfig({ template: "carnet", accessLines: ["Puy du Fou : 8 min · 6 km", "Parking dans la cour"] });
      await page.goto("/");
      const band = page.getByTestId("carnet-adresses");
      await expect(band.locator("dt")).toHaveText(["Puy du Fou"]);
      await expect(band.locator("dd")).toHaveText(["8 min · 6 km", "Parking dans la cour"]);
      // L'accès quitte la fiche « Nous trouver » : pas de doublon.
      await expect(page.locator("#nous-trouver")).not.toContainText("Parking dans la cour");
      await setConfig({ accessLines: [] });
      await page.goto("/");
      await expect(page.getByTestId("carnet-adresses")).toHaveCount(0);
    });

    test("téléphone : menu ☰, barre fixe « à partir de … / nuit — Réserver », boutons Appeler / Itinéraire", async ({ page }) => {
      await setConfig({ template: "carnet" });
      await page.setViewportSize({ width: 390, height: 800 });
      await page.goto("/");
      await page.getByRole("button", { name: "Ouvrir le menu" }).click();
      await expect(page.getByRole("navigation", { name: "Menu" }).getByRole("link", { name: "Chambres" })).toBeVisible();
      await page.keyboard.press("Escape");
      const bar = page.getByTestId("carnet-mobile-bar");
      await expect(bar).toBeVisible();
      await expect(bar).toContainText(/à partir de\s*\d+/);
      await expect(bar.getByRole("link", { name: "Réserver" })).toHaveAttribute("href", "/#dates");
      await expect(page.locator(".c-find-actions").getByRole("link", { name: "Appeler" })).toHaveAttribute("href", /^tel:/);
      await expect(page.locator(".c-find-actions").getByRole("link", { name: "Itinéraire" })).toBeVisible();
      // Bureau : ni barre fixe ni boutons mobiles.
      await page.setViewportSize({ width: 1280, height: 800 });
      await expect(bar).toBeHidden();
      await expect(page.locator(".c-find-actions")).toBeHidden();
    });

    test("page chambre en article : rubrique N°, grand numéro, titre en italique, encart Réserver, À lire aussi", async ({ page }) => {
      await setConfig({ template: "carnet" });
      await page.goto("/chambres/chambre-api-test");
      await expect(page.getByRole("navigation", { name: "Fil d'Ariane" })).toContainText(/N°\d{2} sur \d{2}/);
      const h1 = page.getByRole("heading", { level: 1 });
      await expect(h1).toHaveText("Chambre API Test");
      await expect(h1.locator("em")).toHaveText("API Test");
      await expect(page.locator(".c-article-num")).toHaveText(/^\d{2}$/);
      await expect(page.getByTestId("room-facts")).toContainText("Jusqu'à 2 personnes");
      const book = page.locator(".c-article-book");
      await expect(book.getByRole("heading", { name: "Réserver" })).toBeVisible();
      await expect(book).toContainText("/ nuit");
      // Les dates partent vers la réservation, comme dans les autres templates.
      await page.fill("#room-checkin", fd("2026-09-21"));
      await page.fill("#room-checkout", fd("2026-09-23"));
      await book.getByRole("button", { name: "Voir le tarif et réserver" }).click();
      await expect(page).toHaveURL(/\/reserver\/[0-9a-f-]+\?checkIn=/);
    });

    test("page chambre : UUID ou slug inconnu → 404, jamais 500", async ({ request }) => {
      await setConfig({ template: "carnet" });
      const res = await request.get("/chambres/chambre-qui-nexiste-pas");
      expect(res.status()).toBe(404);
    });

    test("confirmation payée : « À {jour}, {Prénom}. » et récapitulatif à côté", async ({ page }) => {
      await setConfig({ template: "carnet" });
      const { tenantId, apiRoomId } = loadTestContext();
      const session = `cs_test_carnet_${Date.now().toString(36)}`;
      const { rows } = await pool.query(
        `WITH d AS (INSERT INTO dossiers (tenant_id, check_in, check_out, guest_name, guest_email) VALUES ($1, '2030-01-01', '2030-01-02', 'Claire Carnet', 'carnet@example.com') RETURNING id)
         INSERT INTO bookings (tenant_id, room_id, check_in, check_out, total_price, status, guest_name, guest_first_name, guest_email, guest_count, source, dossier_id)
         VALUES ($1, $2, $3, $4, '200.00', 'confirmed', 'Claire Carnet', 'Claire', 'carnet@example.com', 1, 'direct', (SELECT id FROM d))
         RETURNING id, dossier_id`,
        [tenantId, apiRoomId, fd("2026-08-24"), fd("2026-08-26")],
      );
      const { id, dossier_id } = rows[0];
      await pool.query(
        `INSERT INTO payments (tenant_id, dossier_id, stripe_session_id, amount, currency, status) VALUES ($1, $2, $3, '200.00', 'eur', 'succeeded')`,
        [tenantId, dossier_id, session],
      );
      try {
        await page.goto(`/reserver/confirmation?session_id=${session}`);
        const h1 = page.getByRole("heading", { level: 1 });
        await expect(h1).toHaveText(/^À \p{L}+.*, Claire\.$/u);
        await expect(h1.locator("em")).toHaveText("Claire.");
        await expect(page.locator(".s-confirm-card .s-rows")).toContainText("Total");
      } finally {
        await pool.query("DELETE FROM payments WHERE dossier_id = $1", [dossier_id]);
        await pool.query("DELETE FROM bookings WHERE id = $1", [id]);
        await pool.query("DELETE FROM dossiers WHERE id = $1", [dossier_id]);
      }
    });

    test("XSS : accroche et histoire malveillantes rendues comme du texte", async ({ page }) => {
      let dialog = false;
      page.on("dialog", (d) => {
        dialog = true;
        void d.dismiss();
      });
      const evil = "<script>alert(1)</script>";
      await setConfig({ template: "carnet", heroPhoto: null, heroSubtitle: evil, storyText: evil });
      await page.goto("/");
      await expect(page.locator(".c-quote")).toContainText(evil);
      await expect(page.locator(".c-story-text")).toHaveText(evil);
      expect(dialog).toBe(false);
    });
  });
  // ── Le Guide du parc : accueil propre (Guide.tsx) ──────────────────────────
  test.describe("guide", () => {
    const HERO = { id: "x", url: "/api/uploads/inexistant.webp", filename: "inexistant.webp" };

    test.afterEach(async () => {
      await setConfig({
        heroTitle: originalConfig.heroTitle ?? null,
        heroSubtitle: originalConfig.heroSubtitle ?? null,
        heroPhoto: originalConfig.heroPhoto ?? null,
        heroEyebrow: originalConfig.heroEyebrow ?? null,
        storyTitle: originalConfig.storyTitle ?? null,
        storyText: originalConfig.storyText ?? null,
        storyEyebrow: originalConfig.storyEyebrow ?? null,
        primaryColor: originalConfig.primaryColor ?? null,
      });
    });

    test("barre noire : sur-titre et grand nom à l'accueil, nom réduit et sans sur-titre ailleurs", async ({ page }) => {
      await setConfig({ template: "guide", heroEyebrow: "Chambres d'hôtes · Vendée" });
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto("/");
      await expect(page.locator(".g-eyebrow")).toHaveText("Chambres d'hôtes · Vendée");
      const nav = page.getByRole("navigation", { name: "Navigation principale" });
      await expect(nav.getByRole("link", { name: "Réserver" })).toHaveAttribute("href", "/#dates");
      const homeSize = await page.locator(".g-brand-name").evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
      await page.goto("/chambres");
      await expect(page.locator(".g-eyebrow")).toBeHidden();
      const innerSize = await page.locator(".g-brand-name").evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
      expect(homeSize).toBeGreaterThan(innerSize * 1.5);
      // Bande de 6 px à la couleur de l'hôte sous la barre.
      await expect(page.locator(".g-band")).toHaveCSS("height", "6px");
    });

    test("hero : photo + titre de l'hôte ; sans photo, aplat accent avec phrase forte ; jamais de bloc vide", async ({ page }) => {
      await setConfig({ template: "guide", heroPhoto: HERO, heroTitle: null, heroSubtitle: "Trois chambres et le bocage." });
      await page.goto("/");
      // Sans titre saisi : le h1 (nom) est réservé aux lecteurs d'écran, le nom est déjà dans la barre.
      await expect(page.getByRole("heading", { level: 1 })).toHaveClass(/g-sr/);
      await expect(page.locator(".g-pitch")).toHaveText("Trois chambres et le bocage.");
      await expect(page.locator(".g-flat")).toHaveCount(0);

      await setConfig({ heroPhoto: null, heroTitle: "Un jardin clos." });
      await page.goto("/");
      await expect(page.locator(".g-flat h1")).toHaveText("Un jardin clos.");
      await expect(page.locator(".g-hero-photo")).toHaveCount(0);

      // Ni photo, ni titre, ni accroche : la phrase est tirée du nombre de chambres.
      await setConfig({ heroTitle: null, heroSubtitle: null });
      await page.goto("/");
      await expect(page.locator(".g-flat h1")).toHaveText(/^\S+ chambres?\.$/);
      await expect(page.locator(".g-flat-pitch, .g-pitch")).toHaveCount(0);
    });

    test("encart « Planifier votre séjour » et cartes chambre : N°1, prix, lien vers la page chambre", async ({ page }) => {
      await setConfig({ template: "guide" });
      await page.goto("/");
      await expect(page.getByRole("heading", { name: "Planifier votre séjour" })).toBeVisible();
      const row = page.locator(".g-plan-room").filter({ hasText: "Chambre API Test" });
      await expect(row).toContainText("/ nuit");
      const card = page.locator(".g-card").filter({ hasText: "Chambre API Test" });
      await expect(card).toContainText(/N°\d+ Chambre API Test/);
      // Chambre de test sans photo ni description : grand numéro sur aplat, pas de description vide.
      await expect(card.locator(".g-card-flat")).toBeVisible();
      await expect(card.locator(".g-card-desc")).toHaveCount(0);
      await card.click();
      await expect(page).toHaveURL(/\/chambres\/chambre-api-test$/);
    });

    test("La maison : absente (section et lien) sans histoire ; chiffres clés et carte affichés", async ({ page }) => {
      await setConfig({ template: "guide", storyTitle: null, storyText: null, storyEyebrow: null });
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto("/");
      await expect(page.locator("#la-maison")).toHaveCount(0);
      await expect(page.getByRole("link", { name: "La maison" })).toHaveCount(0);
      await expect(page.locator("#chiffres-cles")).toContainText("1820");
      await expect(page.locator("#nous-trouver")).toContainText("84480 Bonnieux");

      await setConfig({ storyText: "Nous avons rouvert la bergerie.", storyEyebrow: "Claire et Antoine" });
      await page.goto("/");
      await expect(page.locator("#la-maison")).toBeVisible();
      await expect(page.locator(".g-signature")).toHaveText("— Claire et Antoine");
    });

    test("contraste : blanc sur accent, accent sur papier, « Réserver » sur la barre, même avec une couleur très claire", async ({ page }) => {
      await setConfig({ template: "guide", primaryColor: "#FFF3B0" });
      await page.goto("/");
      const ratios = await page.locator(".site").evaluate((site) => {
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
        const ratio = (fg: string, bg: string) => {
          const [a, b] = [lum(rgb(fg)), lum(rgb(bg))].sort((x, y) => y - x);
          return (a + 0.05) / (b + 0.05);
        };
        const out = {
          whiteOnAccent: ratio("#fff", "var(--g-accent)"),
          accentOnPaper: ratio("var(--g-accent)", "var(--g-paper)"),
          navOnBar: ratio("var(--g-nav-accent)", "var(--g-bar)"),
          labelOnHover: ratio("var(--g-label)", "var(--g-hover)"),
        };
        probe.remove();
        return out;
      });
      expect(ratios.whiteOnAccent).toBeGreaterThanOrEqual(4.5);
      expect(ratios.accentOnPaper).toBeGreaterThanOrEqual(4.5);
      expect(ratios.navOnBar).toBeGreaterThanOrEqual(4.5);
      expect(ratios.labelOnHover).toBeGreaterThanOrEqual(4.5);
    });

    test("téléphone : une colonne, barre « à partir de … Réserver » fixée en bas, aucun débordement", async ({ page }) => {
      await setConfig({ template: "guide", heroPhoto: HERO, heroSubtitle: "Trois chambres et le bocage." });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.setViewportSize({ width: 360, height: 800 });
      await page.goto("/");
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      const photo = (await page.locator(".g-hero-photo").boundingBox())!;
      const plan = (await page.locator(".g-plan").boundingBox())!;
      expect(plan.y).toBeGreaterThanOrEqual(photo.y + photo.height);
      const bar = page.locator(".g-bar");
      await expect(bar).toContainText(/à partir de.*€ \/ nuit/);
      const box = (await bar.boundingBox())!;
      expect(Math.round(box.y + box.height)).toBe(800);
      await bar.getByRole("link", { name: "Réserver" }).click();
      await expect(page).toHaveURL(/#dates$/);
      // Bureau : la barre disparaît.
      await page.setViewportSize({ width: 1280, height: 900 });
      await expect(bar).toBeHidden();
    });

    test("XSS : titre, accroche et histoire malveillants rendus comme du texte", async ({ page }) => {
      let dialog = false;
      page.on("dialog", (d) => {
        dialog = true;
        void d.dismiss();
      });
      const evil = "<script>alert(1)</script>";
      await setConfig({ template: "guide", heroPhoto: null, heroTitle: evil, heroSubtitle: evil, storyText: evil });
      await page.goto("/");
      await expect(page.locator(".g-flat h1")).toHaveText(evil);
      await expect(page.locator(".g-flat-pitch")).toHaveText(evil);
      await expect(page.locator(".g-story-text")).toHaveText(evil);
      expect(dialog).toBe(false);
    });
  });
  // ── Le Défilant : accueil, en-tête et bandeau de pied propres (Defilant.tsx) ──
  test.describe("defilant", () => {
    test.afterEach(async () => {
      await setConfig({
        heroTitle: originalConfig.heroTitle ?? null,
        heroSubtitle: originalConfig.heroSubtitle ?? null,
        storyTitle: originalConfig.storyTitle ?? null,
        storyText: originalConfig.storyText ?? null,
        storyEyebrow: originalConfig.storyEyebrow ?? null,
        primaryColor: originalConfig.primaryColor ?? null,
        checkInTime: originalConfig.checkInTime ?? null,
      });
    });

    test("bandeau défilant décoratif + vrai h1 ; fond de page vert de la maquette (pas la couleur de l'hôte), contenu sur la feuille", async ({ page }) => {
      await setConfig({ template: "defilant", heroTitle: null, primaryColor: "#5e5c64" });
      await page.goto("/");
      const h1 = page.getByRole("heading", { level: 1 });
      await expect(h1).toHaveClass(/s-sr-only/);
      await expect(h1).toContainText((await page.locator(".d-brand").innerText()).trim());
      await expect(page.locator(".d-ticker-hero")).toHaveAttribute("aria-hidden", "true");
      const [siteBg, sheetBg] = await Promise.all([
        page.locator(".site").evaluate((el) => getComputedStyle(el).backgroundColor),
        page.locator(".d-sheet").evaluate((el) => getComputedStyle(el).backgroundColor),
      ]);
      expect(siteBg).not.toBe(sheetBg);
      // Comme la maquette 2b : vert #2f6b47, néon sur le vert en haut, néon sur nuit en pied.
      expect(siteBg).toBe("rgb(47, 107, 71)");
      await expect(page.locator(".d-ticker-hero")).toHaveCSS("color", "rgb(217, 255, 92)");
      await expect(page.locator(".d-ticker-foot")).toHaveCSS("color", "rgb(217, 255, 92)");
      await expect(page.locator(".d-ticker-foot")).toHaveCSS("background-color", "rgb(13, 26, 18)");
      // Pages intérieures : la feuille porte le contenu.
      await page.goto("/chambres");
      const mainBg = await page.locator(".s-main").evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(mainBg).toBe(sheetBg);
    });

    test("lignes de chambre géantes : numéro 01, prix, lien ; sans photo ni description vide", async ({ page }) => {
      await setConfig({ template: "defilant" });
      await page.goto("/");
      const row = page.locator(".d-row").filter({ hasText: "Chambre API Test" });
      await expect(row).toContainText("/ nuit");
      await expect(row).toContainText(/\d+ pers\./);
      await expect(page.locator(".d-row-num").first()).toHaveText("01");
      await expect(row.locator(".d-row-photo")).toHaveCount(0);
      await expect(row.locator(".d-row-desc")).toHaveCount(0);
      // S'ouvre au focus clavier comme au survol.
      const before = await row.evaluate((el) => getComputedStyle(el).paddingTop);
      await row.focus();
      await expect.poll(() => row.evaluate((el) => getComputedStyle(el).paddingTop)).not.toBe(before);
      await row.click();
      await expect(page).toHaveURL(/\/chambres\/chambre-api-test$/);
    });

    test("bandeau de pied : infos pratiques renseignées seulement ; La maison absente sans histoire", async ({ page }) => {
      await setConfig({ template: "defilant", checkInTime: null, storyTitle: null, storyText: null, storyEyebrow: null });
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto("/");
      const foot = page.locator(".d-ticker-foot");
      await expect(foot).toHaveAttribute("aria-hidden", "true");
      await expect(foot).toContainText("Réservation directe");
      await expect(foot).not.toContainText("Arrivée");
      await expect(page.locator("#la-maison")).toHaveCount(0);
      await expect(page.getByRole("link", { name: "La maison" })).toHaveCount(0);

      await setConfig({ checkInTime: "16h", storyText: "Nous avons rouvert la bergerie.", storyEyebrow: "Claire et Antoine" });
      await page.goto("/");
      await expect(foot).toContainText("Arrivée 16h");
      await expect(page.locator(".d-signature")).toContainText("— Claire et Antoine");
      await expect(page.locator("#chiffres-cles")).toContainText("1820");
      await expect(page.locator("#nous-trouver")).toContainText("84480 Bonnieux");
    });

    test("contraste : texte clair sur l'accent, signature sur la feuille, même avec une couleur très claire", async ({ page }) => {
      await setConfig({ template: "defilant", primaryColor: "#FFF3B0" });
      await page.goto("/");
      const r = await contrastRatios(page, {
        onAccent: ["var(--d-on-accent)", "var(--d-accent)"],
        accentOnSheet: ["var(--d-accent)", "var(--d-sheet)"],
        neonOnNight: ["var(--d-neon)", "var(--d-night)"],
        labelOnNight: ["var(--d-label-dark)", "var(--d-night)"],
        mutedOnSheet: ["var(--d-muted)", "var(--d-sheet)"],
      });
      for (const v of Object.values(r)) expect(v).toBeGreaterThanOrEqual(4.5);
    });

    test("téléphone : aucun débordement, barre flottante « à partir de … » en bas, mouvement coupé si demandé", async ({ page }) => {
      await setConfig({ template: "defilant" });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.setViewportSize({ width: 360, height: 800 });
      await page.goto("/");
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      await expect(page.locator(".d-ticker-hero .d-ticker-track")).toHaveCSS("animation-name", "none");
      const bar = page.locator(".d-bar");
      await expect(bar).toContainText(/à partir de.*€ \/ nuit/);
      const box = (await bar.boundingBox())!;
      expect(box.y + box.height).toBeLessThanOrEqual(800);
      expect(box.y + box.height).toBeGreaterThan(760);
      await page.setViewportSize({ width: 1280, height: 900 });
      await expect(bar).toBeHidden();
    });

    test("XSS : titre, accroche et histoire malveillants rendus comme du texte", async ({ page }) => {
      let dialog = false;
      page.on("dialog", (d) => {
        dialog = true;
        void d.dismiss();
      });
      const evil = "<script>alert(1)</script>";
      await setConfig({ template: "defilant", heroTitle: evil, heroSubtitle: evil, storyText: evil });
      await page.goto("/");
      await expect(page.getByRole("heading", { level: 1 })).toContainText(evil);
      await expect(page.locator(".d-pitch")).toHaveText(evil);
      await expect(page.locator(".d-story-text")).toHaveText(evil);
      expect(dialog).toBe(false);
    });
  });

  // ── La Carte postale : accueil et en-tête propres (Postale.tsx) ──────────────
  test.describe("postale", () => {
    const HERO = { id: "x", url: "/api/uploads/inexistant.webp", filename: "inexistant.webp" };

    test.afterEach(async () => {
      await setConfig({
        heroSubtitle: originalConfig.heroSubtitle ?? null,
        city: originalConfig.city ?? null,
        address: originalConfig.address ?? null,
        storyTitle: originalConfig.storyTitle ?? null,
        storyText: originalConfig.storyText ?? null,
        storyEyebrow: originalConfig.storyEyebrow ?? null,
        primaryColor: originalConfig.primaryColor ?? null,
        heroPhoto: originalConfig.heroPhoto ?? null,
      });
    });

    test("« Bons baisers » : h1 réel avec la commune en grandes lettres, tampon du code postal décoratif", async ({ page }) => {
      await setConfig({ template: "postale", city: "Les Epesses", address: "12 chemin de la Brosse, 85590 Les Epesses" });
      await page.goto("/");
      const h1 = page.getByRole("heading", { level: 1 });
      await expect(h1).toHaveText("Bons baisers des Epesses");
      await expect(h1.locator(".p-letters")).toHaveText("Epesses");
      await expect(page.locator(".p-stamp")).toHaveAttribute("aria-hidden", "true");
      await expect(page.locator(".p-stamp")).toContainText("85590");
      await expect(page.locator(".p-addr-stamp")).toHaveText("85");

      // Sans code postal : ni tampon ni timbre de département ; nom long → taille réduite.
      await setConfig({ city: "Saint-Laurent-sur-Sèvre", address: "2 rue de la Bachellerie" });
      await page.goto("/");
      await expect(h1).toHaveText("Bons baisers de Saint-Laurent-sur-Sèvre");
      await expect(h1.locator(".p-letters")).toHaveAttribute("data-size", "s");
      await expect(page.locator(".p-stamp, .p-addr-stamp")).toHaveCount(0);
    });

    test("cartes chambre : N°1 rouge, prix, lien ; sans photo → numéro sur aplat accent", async ({ page }) => {
      await setConfig({ template: "postale" });
      // Les cartes flottent en boucle : Playwright attend un élément immobile pour cliquer.
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto("/");
      await expect(page.getByRole("heading", { level: 2, name: /chambres?, .* cartes?|Une chambre, une carte/ })).toBeVisible();
      const card = page.locator(".p-card").filter({ hasText: "Chambre API Test" });
      await expect(card.locator(".p-card-num")).toHaveText(/^N°\d+$/);
      await expect(card).toContainText("/ nuit");
      await expect(card.locator(".p-card-flat")).toBeVisible();
      await expect(card.locator(".p-card-desc")).toHaveCount(0);
      await card.click();
      await expect(page).toHaveURL(/\/chambres\/chambre-api-test$/);
    });

    test("lettre des hôtes : message signé + adresse ; aucun bloc sans donnée", async ({ page }) => {
      await setConfig({ template: "postale", storyTitle: null, storyText: null, storyEyebrow: null });
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto("/");
      await expect(page.locator("#la-maison")).toHaveCount(0);
      await expect(page.getByRole("link", { name: "La maison" })).toHaveCount(0);
      await expect(page.locator("#nous-trouver")).toContainText("84480 Bonnieux");
      await expect(page.locator("#chiffres-cles")).toContainText("1820");

      await setConfig({ storyText: "Chers voyageurs, venez voir !", storyEyebrow: "Claire et Antoine" });
      await page.goto("/");
      await expect(page.locator(".p-letter-text")).toHaveText("Chers voyageurs, venez voir !");
      await expect(page.locator(".p-signature")).toHaveText("Claire et Antoine");
    });

    test("contraste : blanc sur le rouge tampon et sur l'accent, accent sur papier, même avec une couleur très claire", async ({ page }) => {
      await setConfig({ template: "postale", primaryColor: "#FFF3B0" });
      await page.goto("/");
      const r = await contrastRatios(page, {
        whiteOnStamp: ["#fff", "var(--p-stamp)"],
        whiteOnAccent: ["#fff", "var(--p-accent)"],
        accentOnPaper: ["var(--p-accent)", "var(--p-paper)"],
        mutedOnPaper: ["var(--p-muted)", "var(--p-paper)"],
      });
      for (const v of Object.values(r)) expect(v).toBeGreaterThanOrEqual(4.5);
    });

    test("téléphone : aucun débordement, barre fixe « à partir de … Réserver », mouvement coupé si demandé", async ({ page }) => {
      await setConfig({ template: "postale", heroPhoto: HERO });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.setViewportSize({ width: 360, height: 800 });
      await page.goto("/");
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      await expect(page.locator(".p-card").first()).toHaveCSS("animation-name", "none");
      const bar = page.locator(".p-bar");
      await expect(bar).toContainText(/à partir de.*€ \/ nuit/);
      const box = (await bar.boundingBox())!;
      expect(Math.round(box.y + box.height)).toBe(800);
      await page.setViewportSize({ width: 1280, height: 900 });
      await expect(bar).toBeHidden();
    });

    test("XSS : commune, accroche et lettre malveillantes rendues comme du texte", async ({ page }) => {
      let dialog = false;
      page.on("dialog", (d) => {
        dialog = true;
        void d.dismiss();
      });
      const evil = "<script>alert(1)</script>";
      await setConfig({ template: "postale", city: evil, heroSubtitle: evil, storyText: evil });
      await page.goto("/");
      await expect(page.locator(".p-letters")).toHaveText(evil);
      await expect(page.locator(".p-pitch")).toHaveText(evil);
      await expect(page.locator(".p-letter-text")).toHaveText(evil);
      expect(dialog).toBe(false);
    });
  });
});
