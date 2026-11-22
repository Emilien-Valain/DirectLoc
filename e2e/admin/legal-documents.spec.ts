import fs from "fs";
import path from "path";
import { Pool } from "pg";
import { test, expect, type Page } from "@playwright/test";

/**
 * Spécification : Tests de non-régression > Admin > Documents légaux
 * Référence : .scratch/remboursements-litiges/issues/01-legal-documents.md
 *
 * Paramètres → Documents légaux sur `test-tenant` : identité légale, niveau d'annulation,
 * textes préremplis, brouillon puis publication. Les colonnes légales du tenant sont
 * sauvegardées avant et restaurées après (les autres specs attendent des documents non publiés).
 */

const ctx = JSON.parse(fs.readFileSync(path.join(process.cwd(), "e2e", ".auth", "test-context.json"), "utf-8")) as {
  tenantId: string;
};

const COLUMNS = [
  "legal_name",
  "legal_form",
  "siret",
  "publication_director",
  "mediator",
  "cancellation_level",
  "cancellation_text",
  "cgv_text",
  "legal_notice_text",
  "privacy_text",
  "legal_published_at",
] as const;
const TEMPLATE_NOTICE = "Modèle fourni à titre indicatif, à vérifier et adapter.";

const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
let saved: Record<string, unknown>;
const dossiers: string[] = [];

async function legalRow() {
  const { rows } = await pool.query(`SELECT ${COLUMNS.join(", ")} FROM tenants WHERE id = $1`, [ctx.tenantId]);
  return rows[0] as Record<(typeof COLUMNS)[number], unknown>;
}

async function resetLegal() {
  await pool.query(
    `UPDATE tenants SET legal_name = NULL, legal_form = NULL, siret = NULL, publication_director = NULL, mediator = NULL,
       cancellation_level = 'moderate', cancellation_text = NULL, cgv_text = NULL, legal_notice_text = NULL,
       privacy_text = NULL, legal_published_at = NULL
     WHERE id = $1`,
    [ctx.tenantId],
  );
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  saved = await legalRow();
});

test.afterAll(async () => {
  await pool.query(`UPDATE tenants SET ${COLUMNS.map((c, i) => `${c} = $${i + 2}`).join(", ")} WHERE id = $1`, [
    ctx.tenantId,
    ...COLUMNS.map((c) => saved[c]),
  ]);
  await pool.query("DELETE FROM dossiers WHERE id = ANY($1::uuid[])", [dossiers]);
  await pool.end();
});

test.beforeEach(resetLegal);

async function openTab(page: Page) {
  await page.goto("/admin/parametres?tab=documents");
  await expect(page.getByRole("tabpanel", { name: "Documents légaux" })).toBeVisible();
  await page.waitForLoadState("networkidle");
}

const textarea = (page: Page, name: string) => page.locator(`textarea[name="${name}"]`);

async function fillIdentity(page: Page) {
  await page.getByLabel("Raison sociale").fill("SARL Mas Test");
  await page.getByLabel("Forme juridique").fill("SARL au capital de 1 000 €");
  await page.getByLabel("SIRET").fill("123 456 789 00012");
  await page.getByLabel("Directeur de la publication").fill("Jeanne Test");
  await page.getByLabel("Médiateur de la consommation").fill("Médiateur Test, www.mediateur.example");
}

test.describe("Admin — Documents légaux", () => {
  test("onglet : mention « modèle » (admin seulement), modèles préremplis, champs manquants signalés et visibles", async ({ page }) => {
    await openTab(page);
    await expect(page.getByTestId("legal-template-notice")).toContainText(TEMPLATE_NOTICE);
    await expect(page.getByTestId("legal-status-draft")).toBeVisible();
    const missing = page.getByTestId("legal-missing");
    for (const f of ["Raison sociale", "SIRET", "Médiateur de la consommation"]) await expect(missing).toContainText(f);
    // Préremplis depuis le tenant, champs manquants laissés visibles.
    await expect(textarea(page, "legalNoticeText")).toHaveValue(/contact@mas-provencal\.fr/);
    await expect(textarea(page, "legalNoticeText")).toHaveValue(/SIRET : \[à compléter\]/);
    await expect(textarea(page, "cgvText")).toHaveValue(/L221-28 12°/);
    await expect(textarea(page, "privacyText")).toHaveValue(/CNIL/);
    // Modérée par défaut (tenants existants).
    await expect(page.getByTestId("cancellation-level-moderate").locator("input")).toBeChecked();
    await expect(page.getByTestId("cancellation-preview")).toContainText("jusqu'à 7 jours avant");

    // La saisie met les modèles à jour en direct, et le signalement disparaît champ par champ.
    await page.getByLabel("SIRET").fill("98765432100017");
    await expect(textarea(page, "legalNoticeText")).toHaveValue(/SIRET : 987 654 321 00017/);
    await expect(missing).not.toContainText("SIRET");
    await fillIdentity(page);
    await expect(page.getByTestId("legal-missing")).toHaveCount(0);
  });

  test("brouillon : niveau Stricte et identité enregistrés, rien publié ; avertissement côté Paiements", async ({ page }) => {
    await openTab(page);
    await fillIdentity(page);
    await page.getByTestId("cancellation-level-strict").click();
    await expect(page.getByTestId("cancellation-preview")).toContainText("jusqu'à 30 jours avant");
    await page.getByRole("button", { name: "Enregistrer le brouillon" }).click();
    await expect(page.getByText("Documents enregistrés.")).toBeVisible();

    const row = await legalRow();
    expect(row).toMatchObject({
      legal_name: "SARL Mas Test",
      siret: "12345678900012", // espaces retirés
      cancellation_level: "strict",
      cancellation_text: null,
      cgv_text: null, // modèle non modifié : il suit les infos du tenant
      legal_notice_text: null,
      legal_published_at: null,
    });

    // Site : toujours la page minimale.
    await page.goto("/conditions-annulation");
    await expect(page.getByTestId("legal-minimal")).toBeVisible();

    await page.goto("/admin/parametres?tab=calendriers");
    await expect(page.getByTestId("payments-no-cancellation-warning")).toContainText("Sans conditions d'annulation publiées");
    await page.getByRole("button", { name: "Publier mes conditions" }).click();
    await expect(page.getByRole("tabpanel", { name: "Documents légaux" })).toBeVisible();
  });

  test("SIRET invalide : refusé, saisie conservée, rien enregistré", async ({ page }) => {
    await openTab(page);
    await page.getByLabel("SIRET").fill("1234");
    await page.getByRole("button", { name: "Enregistrer le brouillon" }).click();
    await expect(page.getByText("Le SIRET compte 14 chiffres").first()).toBeVisible();
    await expect(page.getByLabel("SIRET")).toHaveValue("1234");
    await expect(page.getByLabel("SIRET")).toHaveAttribute("aria-invalid", "true");
    expect((await legalRow()).siret).toBeNull();
  });

  test("Personnalisé vide ou texte trop long : refusé", async ({ page }) => {
    await openTab(page);
    await page.getByTestId("cancellation-level-custom").click();
    // Prérempli avec le niveau affiché, à adapter.
    await expect(textarea(page, "cancellationText")).toHaveValue(/jusqu'à 7 jours avant/);
    await textarea(page, "cancellationText").fill("");
    await page.getByRole("button", { name: "Enregistrer le brouillon" }).click();
    await expect(page.getByText("Rédigez vos conditions d'annulation")).toBeVisible();
    expect((await legalRow()).cancellation_level).toBe("moderate");

    await textarea(page, "cancellationText").fill("Conditions ok.");
    await textarea(page, "cgvText").evaluate((el) => el.removeAttribute("maxlength"));
    await textarea(page, "cgvText").fill("x".repeat(30_001));
    await page.getByRole("button", { name: "Enregistrer le brouillon" }).click();
    await expect(page.getByText("Texte trop long").first()).toBeVisible();
    expect((await legalRow()).cgv_text).toBeNull();
  });

  test("publier : Personnalisé + CGV modifiée → en ligne aussitôt, mention « modèle » absente du site, avertissement Paiements retiré", async ({ page }) => {
    await openTab(page);
    await fillIdentity(page);
    await page.getByTestId("cancellation-level-custom").click();
    const custom = "## Annulation\nRemboursement intégral jusqu'à 3 jours avant l'arrivée (conditions admin-e2e).";
    await textarea(page, "cancellationText").fill(custom);
    const cgv = await textarea(page, "cgvText").inputValue();
    await textarea(page, "cgvText").fill(`${cgv}\n\n## Article perso\nAnimaux acceptés.`);
    await expect(page.getByRole("button", { name: "Revenir au modèle" })).toBeVisible();
    await page.getByRole("button", { name: "Publier mes documents" }).click();
    await expect(page.getByTestId("legal-status-published")).toContainText("Documents publiés");
    await expect(page.getByRole("button", { name: "Publier mes documents" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Enregistrer et mettre en ligne" })).toBeVisible();

    const row = await legalRow();
    expect(row.legal_published_at).not.toBeNull();
    expect(row.cancellation_level).toBe("custom");
    expect(row.cancellation_text).toBe(custom);
    expect(String(row.cgv_text)).toContain("## Article perso");

    await page.goto("/conditions-annulation");
    await expect(page.getByTestId("legal-text")).toContainText("conditions admin-e2e");
    await expect(page.locator("body")).not.toContainText("Modèle fourni");
    await page.goto("/cgv");
    await expect(page.getByRole("heading", { name: "Article perso" })).toBeVisible();
    await expect(page.getByTestId("legal-text")).toContainText("conditions admin-e2e"); // annexe
    await expect(page.locator("body")).not.toContainText("Modèle fourni");

    await page.goto("/admin/parametres?tab=calendriers");
    await expect(page.getByRole("heading", { name: "Paiement Stripe" })).toBeVisible();
    await expect(page.getByTestId("payments-no-cancellation-warning")).toHaveCount(0);

    // Toujours dans l'admin, la mention « modèle » reste affichée.
    await openTab(page);
    await expect(page.getByTestId("legal-template-notice")).toContainText(TEMPLATE_NOTICE);
    await expect(page.getByTestId("legal-status-published")).toBeVisible();

    // Revenir au modèle : le texte de l'hôte est retiré (NULL), le modèle suit à nouveau le tenant.
    await page.getByRole("button", { name: "Revenir au modèle" }).click();
    await expect(textarea(page, "cgvText")).not.toHaveValue(/Article perso/);
    await page.getByRole("button", { name: "Enregistrer et mettre en ligne" }).click();
    await expect(page.getByText("Documents enregistrés.")).toBeVisible();
    expect((await legalRow()).cgv_text).toBeNull();
  });

  test("XSS dans les champs et les textes : saisie conservée dans l'admin, échappée sur le site", async ({ page }) => {
    const dialogs: string[] = [];
    page.on("dialog", (d) => {
      dialogs.push(d.message());
      void d.dismiss();
    });
    const xss = "<script>alert(1)</script>";
    const img = "<img src=x onerror=alert(2)>";
    await openTab(page);
    await page.getByLabel("Raison sociale").fill(`SARL ${xss}`);
    await textarea(page, "privacyText").fill(`## ${img}\n${xss}`);
    await page.getByRole("button", { name: "Publier mes documents" }).click();
    await expect(page.getByTestId("legal-status-published")).toBeVisible();

    await openTab(page);
    await expect(page.getByLabel("Raison sociale")).toHaveValue(`SARL ${xss}`);
    await expect(textarea(page, "privacyText")).toHaveValue(`## ${img}\n${xss}`);

    await page.goto("/confidentialite");
    await expect(page.getByRole("heading", { name: img })).toBeVisible();
    await expect(page.getByTestId("legal-text").locator("script, img")).toHaveCount(0);
    await page.goto("/mentions-legales");
    await expect(page.getByTestId("legal-text")).toContainText(`SARL ${xss}`);
    expect(dialogs).toEqual([]);
  });

  test("fiche Dossier : conditions acceptées au paiement affichées (texte exact, date, niveau)", async ({ page }) => {
    const { rows } = await pool.query(
      `INSERT INTO dossiers (tenant_id, check_in, check_out, guest_name, guest_email, cancellation_level,
         accepted_cancellation_text, accepted_cgv_text, terms_accepted_at)
       VALUES ($1, '2035-05-04', '2035-05-06', 'Voyageur Conditions', 'conditions@example.com', 'moderate',
         'Texte annulation accepté <b>gras</b>', 'Texte CGV accepté', '2026-11-22 13:05:00') RETURNING id`,
      [ctx.tenantId],
    );
    const dossierId = rows[0].id as string;
    dossiers.push(dossierId);
    const { rows: room } = await pool.query("SELECT id FROM rooms WHERE tenant_id = $1 AND slug = 'chambre-api-test'", [ctx.tenantId]);
    await pool.query(
      `INSERT INTO bookings (tenant_id, dossier_id, room_id, check_in, check_out, total_price, status, guest_name, guest_email, guest_count, source)
       VALUES ($1, $2, $3, '2035-05-04', '2035-05-06', '200.00', 'confirmed', 'Voyageur Conditions', 'conditions@example.com', 2, 'direct')`,
      [ctx.tenantId, dossierId, room[0].id],
    );
    try {
      await page.goto(`/admin/dossiers/${dossierId}`);
      const terms = page.getByTestId("dossier-accepted-terms");
      await expect(terms).toContainText("Conditions acceptées au paiement le 22 novembre 2026");
      await expect(terms).toContainText("(annulation modérée)");
      await terms.locator("summary").click();
      await expect(terms).toContainText("Texte annulation accepté <b>gras</b>");
      await expect(terms).toContainText("Texte CGV accepté");
      await expect(terms.locator("b")).toHaveCount(0);
    } finally {
      await pool.query("DELETE FROM bookings WHERE dossier_id = $1", [dossierId]);
    }
  });

  test("non authentifié : l'onglet redirige vers /login", async ({ browser }) => {
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();
    const res = await page.goto("/admin/parametres?tab=documents");
    expect(res?.status()).toBeLessThan(500);
    await expect(page).toHaveURL(/\/login/);
    await context.close();
  });
});
