import { test, expect, type Page } from "@playwright/test";
import { expectAdminGuestName, fillAdminGuestName } from "../helpers/guest";
import fs from "fs";
import path from "path";
import { Pool } from "pg";
import { deleteOrphanDossiers, insertDossier } from "../helpers/dossier";
import { deleteManualBlock, insertManualBlock } from "../helpers/manual-blocks";

/**
 * Spécification : Tests de non-régression > Admin > Modifier une réservation / Liste
 * Issu de la critique design du 2026-10-24 (étape shape) : un client appelle pour
 * décaler son séjour. Avant, l'hôte devait annuler (email d'annulation envoyé au
 * client) puis recréer. La liste s'ouvre sur « À venir » et se cherche par client.
 *
 * Fixtures insérées en SQL sur la « Chambre API Test » (100 €/nuit, 2 pers.), à
 * plus d'un an pour ne croiser aucune autre fixture ; toutes portent un email
 * en `@edit.example` et sont supprimées en afterAll.
 */

const ctx = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "e2e", ".auth", "test-context.json"), "utf-8"),
) as {
  tenantId: string;
  apiRoomId: string;
  bookedCheckIn: string;
  bookedCheckOut: string;
  icalBlockStart: string;
  rivalTenantId: string;
  rivalRoomId: string;
};

const RUN_ID = Date.now().toString(36).slice(-6);
const DOMAIN = "edit.example";
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });

function day(n: number) {
  return new Date(Date.now() + n * 86400000).toISOString().split("T")[0];
}

async function insertBooking(opts: {
  name: string;
  checkIn: string;
  checkOut: string;
  status?: "pending" | "confirmed" | "completed" | "cancelled";
  total?: string;
  phone?: string;
  tenantId?: string;
  roomId?: string;
  source?: "manual" | "direct";
  email?: string;
}) {
  const { rows } = await pool.query(
    `WITH d AS (INSERT INTO dossiers (tenant_id, check_in, check_out, guest_name, guest_email) VALUES ($1, '2030-01-01', '2030-01-02', 'Dossier Test', 'dossier@example.com') RETURNING id)
     INSERT INTO bookings (tenant_id, room_id, check_in, check_out, total_price, status, guest_name, guest_email, guest_phone, guest_count, source, dossier_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, $10, (SELECT id FROM d)) RETURNING id`,
    [
      opts.tenantId ?? ctx.tenantId,
      opts.roomId ?? ctx.apiRoomId,
      opts.checkIn,
      opts.checkOut,
      opts.total ?? "200.00",
      opts.status ?? "confirmed",
      opts.name,
      opts.email ?? `${RUN_ID}@${DOMAIN}`,
      opts.phone ?? null,
      opts.source ?? "manual",
    ],
  );
  return rows[0].id as string;
}

async function insertPayment(bookingId: string, status: "pending" | "paid", amount: string, ageMin = 0) {
  await pool.query(
    `INSERT INTO payments (tenant_id, dossier_id, stripe_session_id, amount, currency, status, created_at)
     VALUES ($1, (SELECT dossier_id FROM bookings WHERE id = $2), $3, $4, 'eur', $5, now() - make_interval(mins => $6))`,
    [ctx.tenantId, bookingId, `cs_edit_${bookingId}`, amount, status, ageMin],
  );
}

async function row(id: string) {
  const { rows } = await pool.query(
    "SELECT check_in::date::text AS check_in, check_out::date::text AS check_out, total_price, status, room_id, guest_name FROM bookings WHERE id = $1",
    [id],
  );
  return rows[0];
}

async function cleanup() {
  const like = `%@${DOMAIN}`;
  await pool.query(
    "DELETE FROM payments WHERE dossier_id IN (SELECT dossier_id FROM bookings WHERE guest_email LIKE $1)",
    [like],
  );
  await pool.query("DELETE FROM bookings WHERE guest_email LIKE $1", [like]);
  await deleteOrphanDossiers(pool);
}

async function openEdit(page: Page, id: string) {
  await page.goto(`/admin/reservations/${id}`);
  await page.getByRole("link", { name: "Modifier", exact: true }).click();
  await expect(page).toHaveURL(`/admin/reservations/${id}/modifier`);
}

/** Le total affiché par le devis en direct (« Nouveau total 300,00 € »). */
async function quotedTotal(page: Page) {
  const box = page.locator('[aria-live="polite"]').filter({ hasText: "Nouveau total" });
  await expect(box).toBeVisible();
  return (await box.locator("strong").innerText()).trim();
}

// Hooks au niveau du fichier : le pool est partagé par les deux describe.
test.beforeAll(cleanup);
test.afterAll(async () => {
  await cleanup();
  await pool.end();
});

test.describe("Admin — Modifier une réservation", () => {
  // ─── Happy path ────────────────────────────────────────────────────────────

  test("décaler le départ : pré-rempli, nouveau total, sans email, statut inchangé", async ({ page }) => {
    const name = `Décalage ${RUN_ID}`;
    const id = await insertBooking({ name, checkIn: day(500), checkOut: day(502) });
    await openEdit(page, id);

    await expectAdminGuestName(page, name);
    await expect(page.locator('[name="roomId"]')).toHaveValue(ctx.apiRoomId);
    // Prévenir le client : coché par défaut
    await expect(page.locator('[name="notifyGuest"]')).toBeChecked();

    await page.locator('[name="checkOut"]').fill(day(503));
    await expect(page.locator('[aria-live="polite"]')).toContainText(/Ancien total 200\s€/);
    await expect(page.locator('[aria-live="polite"]')).toContainText("3 nuits");
    const total = await quotedTotal(page);

    await page.locator('[name="notifyGuest"]').uncheck();
    await page.getByRole("button", { name: "Enregistrer les modifications" }).click();

    await expect(page).toHaveURL(`/admin/reservations/${id}?modifiee=silence`);
    await expect(page.getByText("Réservation modifiée. Aucun email envoyé au client.")).toBeVisible();
    // Jamais d'annulation : le séjour reste confirmé
    await expect(page.getByText("Confirmée", { exact: true })).toBeVisible();
    await expect(page.getByText(/Réservation annulée|annulation a été envoyé/)).toHaveCount(0);

    const after = await row(id);
    expect(after.check_out).toBe(day(503));
    expect(after.status).toBe("confirmed");
    // Le total enregistré est celui que le devis affichait
    expect(Number(after.total_price)).toBe(Number(total.replace(/[^\d,]/g, "").replace(",", ".")));
  });

  test("« Garder l'ancien total » conserve le prix malgré une nuit de plus", async ({ page }) => {
    const id = await insertBooking({ name: `Garde Prix ${RUN_ID}`, checkIn: day(510), checkOut: day(512), total: "180.00" });
    await openEdit(page, id);
    await page.locator('[name="checkOut"]').fill(day(514));
    await expect(page.locator('[aria-live="polite"]')).toContainText("4 nuits");
    await page.getByLabel(/Garder l.ancien total \(180\s€/).check();
    await page.locator('[name="notifyGuest"]').uncheck();
    await page.getByRole("button", { name: "Enregistrer les modifications" }).click();
    await expect(page).toHaveURL(/modifiee=silence$/);
    const after = await row(id);
    expect(after.check_out).toBe(day(514));
    expect(after.total_price).toBe("180.00");
  });

  test("client prévenu : bandeau dit si l'email est parti, jamais d'email d'annulation", async ({ page }) => {
    const id = await insertBooking({ name: `Prévenu ${RUN_ID}`, checkIn: day(520), checkOut: day(522) });
    await openEdit(page, id);
    await page.locator('[name="checkIn"]').fill(day(521));
    await page.locator('[name="checkOut"]').fill(day(523));
    await page.getByRole("button", { name: "Enregistrer les modifications" }).click();
    // SMTP désactivé en test : l'envoi peut échouer, le bandeau le dit alors honnêtement
    await expect(page).toHaveURL(/modifiee=(1|sans-email)$/);
    await expect(page.getByText(/^Réservation modifiée/)).toBeVisible();
    await expect(page.getByText(/annulation a été envoyé/)).toHaveCount(0);
    expect((await row(id)).check_in).toBe(day(521));
  });

  test("total inchangé : pas de case « Garder l'ancien total »", async ({ page }) => {
    // 2 nuits à 100 € (Chambre API Test, sans règle tarifaire) = 200 € : rien à garder
    const id = await insertBooking({ name: `Même Total ${RUN_ID}`, checkIn: day(515), checkOut: day(517), total: "200.00" });
    await openEdit(page, id);
    await expect(page.locator('[aria-live="polite"]')).toContainText(/Nouveau total\s*200\s€/);
    await expect(page.getByLabel(/Garder l.ancien total/)).toHaveCount(0);
  });

  test("détail en attente : la décision avant le détail, les documents à la fin", async ({ page }) => {
    const id = await insertBooking({ name: `Ordre ${RUN_ID}`, checkIn: day(518), checkOut: day(519), status: "pending", source: "direct" });
    await page.goto(`/admin/reservations/${id}`);
    const y = async (l: ReturnType<Page["locator"]>) => (await l.boundingBox())!.y;
    const explainer = await y(page.locator("[data-pending-explainer]"));
    const confirm = await y(page.getByRole("button", { name: "Confirmer" }));
    const stay = await y(page.getByText("Séjour", { exact: true }));
    const pdf = await y(page.getByRole("link", { name: /Télécharger PDF/ }));
    expect(explainer).toBeLessThan(stay);
    expect(confirm).toBeLessThan(stay);
    expect(stay).toBeLessThan(pdf);
  });

  test("décaler sur ses propres nuits n'est pas un conflit", async ({ page }) => {
    const id = await insertBooking({ name: `Chevauche Soi ${RUN_ID}`, checkIn: day(530), checkOut: day(533) });
    await openEdit(page, id);
    // Une nuit plus tôt : recouvre les nuits du séjour lui-même
    await page.locator('[name="checkIn"]').fill(day(529));
    await page.locator('[name="checkOut"]').fill(day(532));
    await page.locator('[name="notifyGuest"]').uncheck();
    await page.getByRole("button", { name: "Enregistrer les modifications" }).click();
    await expect(page).toHaveURL(/modifiee=silence$/);
    expect((await row(id)).check_in).toBe(day(529));
  });

  test("déjà payé en ligne : l'écart à régler est affiché, rien n'est débité", async ({ page }) => {
    const id = await insertBooking({ name: `Payé ${RUN_ID}`, checkIn: day(540), checkOut: day(542), source: "direct" });
    await insertPayment(id, "paid", "200.00");
    await openEdit(page, id);
    await page.locator('[name="checkOut"]').fill(day(544));
    await expect(page.locator("[data-paid-difference]")).toContainText(/Déjà payé en ligne : 200\s€/);
    await expect(page.locator("[data-paid-difference]")).toContainText("Différence à régler avec le client : +");
    // Ancien total gardé = montant payé : plus d'écart
    await page.getByLabel(/Garder l.ancien total/).check();
    await expect(page.locator("[data-paid-difference]")).toHaveCount(0);
  });

  // ─── Conflits ──────────────────────────────────────────────────────────────

  test("conflit avec un autre séjour : nommé, « Forcer » proposé, rien n'est écrit", async ({ page }) => {
    const id = await insertBooking({ name: `Conflit ${RUN_ID}`, checkIn: day(550), checkOut: day(552) });
    await openEdit(page, id);
    // Les dates de la réservation fixture « Test API Réservation »
    await page.locator('[name="checkIn"]').fill(ctx.bookedCheckIn);
    await page.locator('[name="checkOut"]').fill(ctx.bookedCheckOut);
    await page.getByRole("button", { name: "Enregistrer les modifications" }).click();
    // Filtré : l'annonceur de route de Next porte aussi role=alert
    await expect(page.getByRole("alert").filter({ hasText: "chevauchent" })).toContainText(
      "Ces dates chevauchent le séjour de Test API Réservation",
    );
    await expect(page.locator('input[name="force"]')).toBeVisible();
    // La saisie est conservée, et la réservation n'a pas bougé
    await expect(page.locator('[name="checkIn"]')).not.toHaveValue("");
    expect((await row(id)).check_in).toBe(day(550));
  });

  test("conflit avec un blocage iCal : nommé comme une réservation Airbnb/Booking", async ({ page }) => {
    const id = await insertBooking({ name: `Conflit iCal ${RUN_ID}`, checkIn: day(560), checkOut: day(562) });
    await openEdit(page, id);
    const start = new Date(ctx.icalBlockStart + "T00:00:00Z");
    const next = new Date(start.getTime() + 86400000).toISOString().slice(0, 10);
    await page.locator('[name="checkIn"]').fill(ctx.icalBlockStart);
    await page.locator('[name="checkOut"]').fill(next);
    await page.getByRole("button", { name: "Enregistrer les modifications" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "chevauchent" })).toContainText("chevauchent une réservation Airbnb ou Booking");
    expect((await row(id)).check_in).toBe(day(560));
  });

  test("départ avant l'arrivée → erreur sur le champ, rien n'est écrit", async ({ page }) => {
    const id = await insertBooking({ name: `Dates Folles ${RUN_ID}`, checkIn: day(570), checkOut: day(572) });
    await openEdit(page, id);
    await page.locator('[name="checkOut"]').fill(day(568));
    await page.getByRole("button", { name: "Enregistrer les modifications" }).click();
    await expect(page.getByText("La date de départ doit être après la date d'arrivée").first()).toBeVisible();
    await expect(page).toHaveURL(`/admin/reservations/${id}/modifier`);
    expect((await row(id)).check_out).toBe(day(572));
  });

  // ─── Qui peut être modifié ─────────────────────────────────────────────────

  test("terminée ou annulée : pas de « Modifier », et l'URL directe → 404", async ({ page }) => {
    for (const status of ["completed", "cancelled"] as const) {
      const id = await insertBooking({ name: `Figée ${status} ${RUN_ID}`, checkIn: day(580), checkOut: day(581), status });
      await page.goto(`/admin/reservations/${id}`);
      await expect(page.getByRole("link", { name: "Modifier", exact: true })).toHaveCount(0);
      const res = await page.goto(`/admin/reservations/${id}/modifier`);
      expect(res?.status()).toBe(404);
    }
  });

  test("paiement en ligne en cours : la modification attend la fin du Checkout", async ({ page }) => {
    const id = await insertBooking({ name: `En Paiement ${RUN_ID}`, checkIn: day(590), checkOut: day(591), status: "pending", source: "direct" });
    await insertPayment(id, "pending", "100.00", 5);
    await page.goto(`/admin/reservations/${id}`);
    await expect(page.getByText("Paiement en ligne en cours")).toBeVisible();
    await expect(page.getByRole("link", { name: "Modifier", exact: true })).toHaveCount(0);
    // L'absence du bouton est expliquée
    await expect(page.getByText("Modifiable une fois le paiement en ligne terminé ou expiré.")).toBeVisible();
    const res = await page.goto(`/admin/reservations/${id}/modifier`);
    expect(res?.status()).toBe(404);
  });

  test("UUID inconnu, id malformé, réservation d'un autre tenant → 404, jamais 500", async ({ page }) => {
    const rival = await insertBooking({
      name: `Rival Edit ${RUN_ID}`,
      checkIn: day(600),
      checkOut: day(601),
      tenantId: ctx.rivalTenantId,
      roomId: ctx.rivalRoomId,
    });
    for (const id of ["00000000-0000-0000-0000-000000000000", "pas-un-uuid", rival]) {
      const res = await page.goto(`/admin/reservations/${id}/modifier`);
      expect(res?.status()).toBe(404);
    }
    await expect(page.getByText(`Rival Edit ${RUN_ID}`)).toHaveCount(0);
  });

  test("sans session : /modifier redirige vers /login", async ({ browser }) => {
    const id = await insertBooking({ name: `Anonyme ${RUN_ID}`, checkIn: day(610), checkOut: day(611) });
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();
    await page.goto(`/admin/reservations/${id}/modifier`);
    await expect(page).toHaveURL(/\/login/);
    await context.close();
  });

  test("XSS dans le nom modifié : texte échappé, aucun dialog", async ({ page }) => {
    let fired = false;
    page.on("dialog", async (d) => {
      fired = true;
      await d.dismiss();
    });
    const id = await insertBooking({ name: `Sain ${RUN_ID}`, checkIn: day(620), checkOut: day(621) });
    await openEdit(page, id);
    const evil = `<script>alert(1)</script> ${RUN_ID}`;
    await fillAdminGuestName(page, evil);
    await page.locator('[name="notifyGuest"]').uncheck();
    await page.getByRole("button", { name: "Enregistrer les modifications" }).click();
    await expect(page).toHaveURL(/modifiee=silence$/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("<script>alert(1)</script>");
    expect(fired).toBe(false);
  });
});

test.describe("Admin — Liste des réservations : à venir, anciennes, recherche", () => {
  test("« À venir » par défaut : prochaine arrivée d'abord, ni terminées ni annulées", async ({ page }) => {
    // Jeton propre à ce test : les fixtures des autres tests contiennent aussi RUN_ID.
    const tag = `L${RUN_ID}`;
    const later = `Tard ${tag}`;
    const sooner = `Tôt ${tag}`;
    const done = `Finie ${tag}`;
    const gone = `Annulée ${tag}`;
    await insertBooking({ name: later, checkIn: day(700), checkOut: day(701) });
    await insertBooking({ name: sooner, checkIn: day(650), checkOut: day(651) });
    await insertBooking({ name: done, checkIn: day(660), checkOut: day(661), status: "completed" });
    await insertBooking({ name: gone, checkIn: day(670), checkOut: day(671), status: "cancelled" });

    await page.goto(`/admin/reservations?q=${tag}`);
    await expect(page.getByRole("link", { name: "À venir" })).toHaveAttribute("aria-current", "page");
    const rows = page.locator("tbody tr");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText(sooner);
    await expect(rows.nth(1)).toContainText(later);

    await page.getByRole("link", { name: "Anciennes" }).click();
    await expect(page).toHaveURL(/vue=anciennes/);
    await expect(page).toHaveURL(new RegExp(`q=${tag}`));
    await expect(rows).toHaveCount(2);
    // Anciennes : la plus récente d'abord
    await expect(rows.nth(0)).toContainText(gone);
    await expect(rows.nth(1)).toContainText(done);
  });

  test("?status=cancelled ouvre « Anciennes » ; filtres actifs annoncés (aria-current)", async ({ page }) => {
    await page.goto("/admin/reservations?status=cancelled");
    await expect(page.getByRole("link", { name: "Anciennes" })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("link", { name: "Annulée", exact: true })).toHaveAttribute("aria-current", "true");
    await expect(page.getByRole("link", { name: "Toutes les chambres" })).toHaveAttribute("aria-current", "true");
  });

  test("recherche par nom (casse ignorée), email et téléphone avec ou sans espaces", async ({ page }) => {
    const name = `Martine Rechercheuse ${RUN_ID}`;
    await insertBooking({
      name,
      checkIn: day(680),
      checkOut: day(681),
      phone: "06 98 76 54 32",
      email: `martine-${RUN_ID}@${DOMAIN}`,
    });
    for (const q of [`martine rechercheuse ${RUN_ID}`.toUpperCase(), `martine-${RUN_ID}@`, "0698765432", "98 76 54 32"]) {
      await page.goto(`/admin/reservations?q=${encodeURIComponent(q)}`);
      await expect(page.locator("tbody tr").filter({ hasText: name })).toHaveCount(1);
    }
    // Saisie via le formulaire : le champ garde la recherche
    await page.goto("/admin/reservations");
    await page.getByRole("searchbox", { name: "Rechercher un client" }).fill(`Rechercheuse ${RUN_ID}`);
    await page.getByRole("button", { name: "Rechercher" }).click();
    await expect(page).toHaveURL(/q=Rechercheuse/);
    await expect(page.getByRole("searchbox", { name: "Rechercher un client" })).toHaveValue(`Rechercheuse ${RUN_ID}`);
    await expect(page.locator("tbody tr")).toHaveCount(1);
  });

  test("recherche sans résultat : message dédié + « Effacer la recherche » ; % n'est pas un joker", async ({ page }) => {
    await page.goto(`/admin/reservations?q=${encodeURIComponent(`introuvable-${RUN_ID}`)}`);
    const empty = page.locator("[data-empty-state]");
    await expect(empty.getByText(`Aucune réservation pour « introuvable-${RUN_ID} »`)).toBeVisible();
    await empty.getByRole("link", { name: "Effacer la recherche" }).click();
    await expect(page).toHaveURL(/\/admin\/reservations$/);

    await page.goto("/admin/reservations?q=%25");
    await expect(page.locator("[data-empty-state]").getByText("Aucune réservation pour « % »")).toBeVisible();
  });

  test("recherche XSS : affichée échappée, aucun dialog", async ({ page }) => {
    let fired = false;
    page.on("dialog", async (d) => {
      fired = true;
      await d.dismiss();
    });
    // Charge propre au test : le test XSS du formulaire laisse un client nommé <script>… jusqu'au nettoyage.
    const payload = `<script>alert('q-${RUN_ID}')</script>`;
    await page.goto(`/admin/reservations?q=${encodeURIComponent(payload)}`);
    await expect(page.getByText(`Aucune réservation pour « ${payload} »`)).toBeVisible();
    expect(fired).toBe(false);
  });

  test("plus de 50 anciennes : pagination, page 2 contient le reste", async ({ page }) => {
    const email = `pages-${RUN_ID}@${DOMAIN}`;
    const values: string[] = [];
    for (let i = 0; i < 51; i++) {
      const d = day(800 + i);
      const dossierId = await insertDossier(pool, ctx.tenantId);
      values.push(`('${ctx.tenantId}', '${dossierId}', '${ctx.apiRoomId}', '${d}', '${d}'::date + 1, '100.00', 'cancelled', 'Page ${String(i).padStart(2, "0")} ${RUN_ID}', '${email}', 1, 'manual')`);
    }
    await pool.query(
      `INSERT INTO bookings (tenant_id, dossier_id, room_id, check_in, check_out, total_price, status, guest_name, guest_email, guest_count, source) VALUES ${values.join(",")}`,
    );
    await page.goto(`/admin/reservations?vue=anciennes&q=${encodeURIComponent(email)}`);
    await expect(page.locator("tbody tr")).toHaveCount(50);
    await expect(page.getByText("Page 1 sur 2")).toBeVisible();
    await expect(page.locator("tbody tr").first()).toContainText(`Page 50 ${RUN_ID}`);
    await page.getByRole("link", { name: "Plus anciennes →" }).click();
    await expect(page).toHaveURL(/page=2/);
    await expect(page.locator("tbody tr")).toHaveCount(1);
    await expect(page.locator("tbody tr")).toContainText(`Page 00 ${RUN_ID}`);
    await page.getByRole("link", { name: "← Plus récentes" }).click();
    await expect(page.getByText("Page 1 sur 2")).toBeVisible();
  });

  test("paramètres malformés (?vue=zzz&status=foo&page=abc&roomId=x) → 200, pas de 500", async ({ page }) => {
    for (const qs of ["vue=zzz&status=foo&page=abc&roomId=x", "vue=anciennes&page=-4", "page=99999&vue=anciennes"]) {
      const res = await page.goto(`/admin/reservations?${qs}`);
      expect(res?.status()).toBe(200);
      await expect(page.getByRole("heading", { level: 1, name: "Réservations" })).toBeVisible();
    }
  });
});

test.describe("Admin — Annuler, forcer : ce que la décision implique", () => {
  async function openCancelDialog(page: Page, id: string) {
    await page.goto(`/admin/reservations/${id}`);
    await page.getByRole("button", { name: "Annuler la réservation" }).click();
    return page.locator("dialog[open] [data-refund-note]");
  }

  test("dialog d'annulation : dit s'il y a de l'argent à rendre (en ligne, hors ligne, rien)", async ({ page }) => {
    const paid = await insertBooking({ name: `Rembourse ${RUN_ID}`, checkIn: day(850), checkOut: day(852), source: "direct" });
    await insertPayment(paid, "paid", "240.00");
    const note = await openCancelDialog(page, paid);
    await expect(note).toContainText(/Rembourse \w+ a payé 240\s€ en ligne\./);
    await expect(note).toContainText("L'annulation ne le rembourse pas : faites-le depuis votre tableau de bord Stripe.");
    await page.locator("dialog[open]").getByRole("button", { name: "Garder" }).click();
    expect((await row(paid)).status).toBe("confirmed");

    const offline = await insertBooking({ name: `Hors Ligne ${RUN_ID}`, checkIn: day(854), checkOut: day(855) });
    await pool.query("UPDATE bookings SET paid_at = now() WHERE id = $1", [offline]);
    await expect(await openCancelDialog(page, offline)).toContainText("Vous avez noté un règlement le");

    const unpaid = await insertBooking({ name: `Rien Payé ${RUN_ID}`, checkIn: day(856), checkOut: day(857) });
    await expect(await openCancelDialog(page, unpaid)).toHaveText("Aucun paiement à rembourser.");
  });

  test("annuler une réservation payée en ligne : le bandeau rappelle de rembourser", async ({ page }) => {
    const id = await insertBooking({ name: `Annule Payé ${RUN_ID}`, checkIn: day(860), checkOut: day(862), source: "direct" });
    await insertPayment(id, "paid", "200.00");
    await openCancelDialog(page, id);
    await page.locator("dialog[open] [data-confirm]").click();
    await expect(page).toHaveURL(/annulee=(1|sans-email)$/);
    await expect(page.getByText("Payé, à rembourser")).toBeVisible();
    await expect(page.getByText(/a payé 200\s?€\s?en ligne et la réservation est annulée/)).toBeVisible();
  });

  async function submitNew(page: Page, checkIn: string, checkOut: string, name: string) {
    await page.goto(`/admin/reservations/new?roomId=${ctx.apiRoomId}&checkIn=${checkIn}&checkOut=${checkOut}`);
    await fillAdminGuestName(page, name);
    await page.fill('[name="guestEmail"]', `${RUN_ID}@${DOMAIN}`);
    await page.click('[type="submit"]');
    const panel = page.locator("[data-force-panel]");
    await expect(panel).toBeVisible();
    // Une seule alerte de conflit (le panneau), collée à la case et au bouton
    await expect(page.getByRole("alert").filter({ hasText: "chevauchent" })).toHaveCount(1);
    await expect(panel.getByRole("checkbox", { name: "Enregistrer quand même" })).toBeVisible();
    await expect(panel.getByRole("link", { name: "Voir le calendrier" })).toBeVisible();
    return panel;
  }

  test("forcer sur un séjour : nomme le client et dit que deux clients partageront la chambre", async ({ page }) => {
    const name = `Force Séjour ${RUN_ID}`;
    const panel = await submitNew(page, ctx.bookedCheckIn, ctx.bookedCheckOut, name);
    await expect(panel).toContainText("Ces dates chevauchent le séjour de Test API Réservation");
    await expect(panel).toContainText("Test API Réservation occupe déjà la chambre");
    await expect(panel).toContainText("deux clients en même temps");
    // Rien n'est créé tant que la case n'est pas cochée
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM bookings WHERE guest_name = $1", [name]);
    expect(rows[0].n).toBe(0);
  });

  test("forcer sur un import Airbnb/Booking : explique le cas « même réservation recopiée »", async ({ page }) => {
    const start = new Date(ctx.icalBlockStart + "T00:00:00Z");
    const next = new Date(start.getTime() + 86400000).toISOString().slice(0, 10);
    const panel = await submitNew(page, ctx.icalBlockStart, next, `Force iCal ${RUN_ID}`);
    await expect(panel).toContainText("Ces dates chevauchent une réservation Airbnb ou Booking");
    await expect(panel).toContainText("Si c'est la même réservation, recopiée ici");
  });

  test("forcer sur un blocage manuel : le dit comme posé par l'hôte", async ({ page }) => {
    const blockId = await insertManualBlock({
      tenantId: ctx.tenantId,
      roomId: ctx.apiRoomId,
      startDate: new Date(day(900) + "T00:00:00Z"),
      endDate: new Date(day(903) + "T00:00:00Z"),
    });
    try {
      const panel = await submitNew(page, day(901), day(902), `Force Blocage ${RUN_ID}`);
      await expect(panel).toContainText("Ces dates chevauchent un blocage que vous avez posé");
      await expect(panel).toContainText("n'a plus lieu d'être");
    } finally {
      await deleteManualBlock(blockId);
    }
  });
});
