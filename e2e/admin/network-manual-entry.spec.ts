import fs from "fs";
import path from "path";
import { Pool } from "pg";
import { test, expect, type Page } from "@playwright/test";
import { startSmtpSink } from "../helpers/smtp-sink";
import { mailText as mailBody, mailSubject } from "../helpers/mail-body";
import { deleteOrphanDossiers } from "../helpers/dossier";

/**
 * Spécification : Tests de non-régression > Admin > Réseau des Voisins : saisie « Venu par le réseau ».
 * Issue `.scratch/reseau-voisins/issues/04-referral-notifications.md`, ADR-0013.
 *
 * Le tenant test devient membre du réseau le temps du spec (domaine posé, GPS du seed), puis son
 * domaine est restauré. Tenants dédiés : V = Voisin membre (~5 km, nom piégé XSS, un admin qui
 * reçoit les emails) ; N = hôtel hors réseau tout près. Dates en 2036, tout est supprimé.
 */

const ctx = JSON.parse(fs.readFileSync(path.join(process.cwd(), "e2e", ".auth", "test-context.json"), "utf-8")) as {
  tenantId: string;
  apiRoomId: string;
  rivalTenantId: string;
};
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
const S = Math.random().toString(36).slice(2, 8);
const EMAIL = `network-manual-${S}@guest.test`;
const GUEST_LAST = `Voyageuse${S}`;
const V_NAME = `Ferme <script>alert(1)</script> du Puy ${S}`;
const V_ADMIN = `nm-admin-${S}@example.test`;
const T: Record<string, string> = {};
let roomId: string;
let oldDomain: string | null = null;
let sink: Awaited<ReturnType<typeof startSmtpSink>>;

async function makeTenant(key: "v" | "n", name: string, config: object) {
  const { rows } = await pool.query(
    `INSERT INTO tenants (slug, name, domain, config) VALUES ($1, $2, $3, $4::jsonb) RETURNING id`,
    [`nm${key}-${S}`, name, `nm${key}-${S}.example.test`, JSON.stringify(config)],
  );
  T[key] = rows[0].id;
}

async function cleanup() {
  const { rows } = await pool.query("SELECT id FROM dossiers WHERE guest_email = $1", [EMAIL]);
  const ids = rows.map((r) => r.id as string);
  await pool.query("DELETE FROM referrals WHERE from_dossier_id = ANY($1::uuid[]) OR to_dossier_id = ANY($1::uuid[])", [ids]);
  await pool.query("DELETE FROM payments WHERE dossier_id = ANY($1::uuid[])", [ids]);
  await pool.query("DELETE FROM booking_lines WHERE booking_id IN (SELECT id FROM bookings WHERE dossier_id = ANY($1::uuid[]))", [ids]);
  await pool.query("DELETE FROM bookings WHERE dossier_id = ANY($1::uuid[])", [ids]);
  await pool.query("DELETE FROM dossiers WHERE id = ANY($1::uuid[])", [ids]);
  await deleteOrphanDossiers(pool);
}

const dossiersOfGuest = async () =>
  (await pool.query("SELECT referred_by_tenant_id, network_notified_at FROM dossiers WHERE guest_email = $1", [EMAIL])).rows;
/** Admins du tenant test (chacun reçoit l'email « Réservation obtenue »). */
const hostAdmins = async () =>
  (await pool.query("SELECT count(*)::int AS n FROM user_tenants WHERE tenant_id = $1", [ctx.tenantId])).rows[0].n as number;
const networkMails = () => sink.mails.filter((m) => /réseau DirectLoc|Réseau DirectLoc/.test(mailSubject(m)));

async function fillForm(page: Page) {
  await page.goto("/admin/reservations/new");
  await page.locator('select[name="roomId"]').selectOption(roomId);
  await page.locator('[name="checkIn"]').fill("2036-04-07");
  await page.locator('[name="checkOut"]').fill("2036-04-09");
  await page.locator('[name="guestFirstName"]').fill("Léa");
  await page.locator('[name="guestLastName"]').fill(GUEST_LAST);
  await page.fill('[name="guestEmail"]', EMAIL);
  await page.fill('[name="guestPhone"]', "06 55 44 33 22");
  await page.fill('[name="guestCount"]', "2");
}

test.describe("Admin — Réseau des Voisins : saisie « Venu par le réseau »", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    const { rows: [tenant] } = await pool.query("SELECT domain, config FROM tenants WHERE id = $1", [ctx.tenantId]);
    oldDomain = tenant.domain;
    const lat = Number(tenant.config.latitude);
    const lng = Number(tenant.config.longitude);
    expect(Number.isFinite(lat) && Number.isFinite(lng), "GPS du seed").toBe(true);
    // Membre du réseau : GPS (seed) + domaine actif.
    await pool.query("UPDATE tenants SET domain = $2 WHERE id = $1", [ctx.tenantId, `nm-test-${S}.example.test`]);
    await makeTenant("v", V_NAME, { latitude: lat + 0.045, longitude: lng, city: "Les Épesses", phone: "02 51 99 99 99" });
    await makeTenant("n", `Hors Réseau ${S}`, { latitude: lat + 0.01, longitude: lng, networkEnabled: false });
    await pool.query("INSERT INTO users (id, name, email, email_verified) VALUES ($1, 'Admin V', $2, true)", [`nm-v-${S}`, V_ADMIN]);
    await pool.query("INSERT INTO user_tenants (user_id, tenant_id) VALUES ($1, $2)", [`nm-v-${S}`, T.v]);
    const { rows } = await pool.query(
      `INSERT INTO rooms (tenant_id, property_id, name, slug, price_per_night, capacity)
       SELECT tenant_id, property_id, $2, $3, '100.00', 4 FROM rooms WHERE id = $1 RETURNING id`,
      [ctx.apiRoomId, `Réseau Manuel ${S}`, `reseau-manuel-${S}`],
    );
    roomId = rows[0].id;
    sink = await startSmtpSink();
  });

  test.afterEach(async () => {
    await cleanup();
    sink.mails.length = 0;
  });

  test.afterAll(async () => {
    await sink?.stop();
    await cleanup();
    await pool.query("UPDATE tenants SET domain = $2 WHERE id = $1", [ctx.tenantId, oldDomain]);
    await pool.query("DELETE FROM rooms WHERE id = $1", [roomId]);
    await pool.query("DELETE FROM users WHERE id = $1", [`nm-v-${S}`]);
    await pool.query("DELETE FROM tenants WHERE id = ANY($1::uuid[])", [Object.values(T)]);
    await pool.end();
  });

  test("case cochée → Dossier attribué au Voisin, emails au Voisin et à l'hôte, sans donnée voyageur pour le Voisin envoyeur", async ({ page }) => {
    let dialogs = 0;
    page.on("dialog", (d) => {
      dialogs++;
      void d.dismiss();
    });
    await fillForm(page);
    const field = page.getByTestId("network-referral");
    await expect(field).toBeVisible();
    await expect(page.locator('select[name="networkVoisin"]')).toHaveCount(0); // liste seulement une fois cochée
    await field.getByLabel(/Venu par le réseau/).check();
    const select = page.locator('select[name="networkVoisin"]');
    // Liste = Voisins membres seulement (nom échappé, distance) ; ni l'hôtel hors réseau ni soi-même.
    await expect(select.locator("option", { hasText: V_NAME })).toHaveCount(1);
    await expect(select.locator("option", { hasText: V_NAME })).toContainText(/Les Épesses \(5 km\)/);
    await expect(select.locator(`option[value="${T.n}"]`)).toHaveCount(0);
    await expect(select.locator(`option[value="${ctx.tenantId}"]`)).toHaveCount(0);
    await expect(select.locator(`option[value="${ctx.rivalTenantId}"]`)).toHaveCount(0);
    await select.selectOption(T.v);
    await page.getByRole("button", { name: "Enregistrer", exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/reservations\/[0-9a-f-]{36}\?enregistree=1/, { timeout: 20_000 });

    const rows = await dossiersOfGuest();
    expect(rows).toHaveLength(1);
    expect(rows[0].referred_by_tenant_id).toBe(T.v);
    expect(rows[0].network_notified_at).not.toBeNull();

    const mails = networkMails();
    expect(mails).toHaveLength((await hostAdmins()) + 1);
    const toHost = mails.find((m) => m.to.includes(process.env.TEST_ADMIN_EMAIL ?? "admin@test.maresa"));
    const toVoisin = mails.find((m) => m.to.includes(V_ADMIN));
    expect(mailSubject(toHost!)).toBe(`Réservation obtenue grâce à ${V_NAME} (réseau DirectLoc)`);
    expect(mailSubject(toVoisin!)).toMatch(/^Réseau DirectLoc : le voyageur orienté vers /);
    const voisinBody = mailBody(toVoisin!);
    expect(voisinBody).toContain("était complet du 7 avril 2036 au 9 avril 2036");
    for (const leak of [GUEST_LAST, "Léa", EMAIL, "06 55 44 33 22"]) expect(voisinBody, leak).not.toContain(leak);
    expect(mailBody(toHost!)).toContain("Ferme &lt;script&gt;alert(1)&lt;/script&gt; du Puy");
    expect(mailBody(toHost!)).not.toContain("<script>alert(1)");
    expect(dialogs).toBe(0);
  });

  test("case non cochée → réservation normale, non attribuée, aucun email du réseau", async ({ page }) => {
    await fillForm(page);
    await page.getByRole("button", { name: "Enregistrer", exact: true }).click();
    await expect(page).toHaveURL(/\?enregistree=1/, { timeout: 20_000 });
    expect(await dossiersOfGuest()).toEqual([{ referred_by_tenant_id: null, network_notified_at: null }]);
    expect(networkMails()).toHaveLength(0);
  });

  test("isolation : Voisin hors réseau, autre tenant, soi-même, id forgé ou vide → refusé, rien n'est créé, aucun email", async ({ page }) => {
    for (const forged of [T.n, ctx.rivalTenantId, ctx.tenantId, "00000000-0000-4000-8000-000000000000", "pas-un-uuid", ""]) {
      await fillForm(page);
      await page.getByTestId("network-referral").getByLabel(/Venu par le réseau/).check();
      // Contourne la liste : option ajoutée à la main, `required` retiré.
      await page.locator('select[name="networkVoisin"]').evaluate((el, value) => {
        const s = el as HTMLSelectElement;
        s.required = false;
        s.add(new Option("forgé", value));
        s.value = value;
      }, forged);
      await page.getByRole("button", { name: "Enregistrer", exact: true }).click();
      await expect(page.getByRole("alert").filter({ hasText: "Ce Voisin n'est pas dans votre réseau." }), forged).toBeVisible();
      expect(await dossiersOfGuest(), forged).toEqual([]);
    }
    expect(networkMails()).toHaveLength(0);
  });

  test("Dossier de 2 chambres avec la case → attribué, mêmes emails, une seule fois", async ({ page }) => {
    const { rows } = await pool.query(
      `INSERT INTO rooms (tenant_id, property_id, name, slug, price_per_night, capacity)
       SELECT tenant_id, property_id, $2, $3, '100.00', 2 FROM rooms WHERE id = $1 RETURNING id`,
      [ctx.apiRoomId, `Réseau Manuel Bis ${S}`, `reseau-manuel-bis-${S}`],
    );
    const second = rows[0].id as string;
    try {
      await fillForm(page);
      await page.getByRole("button", { name: "+ Ajouter une chambre" }).click();
      const more = page.locator("[data-more-room='0']");
      await more.locator("select").selectOption(second);
      await more.locator('input[type="number"]').first().fill("1");
      await page.getByTestId("network-referral").getByLabel(/Venu par le réseau/).check();
      await page.locator('select[name="networkVoisin"]').selectOption(T.v);
      await page.getByRole("button", { name: "Enregistrer", exact: true }).click();
      await expect(page).toHaveURL(/\/admin\/dossiers\/[0-9a-f-]{36}\?enregistre=1/, { timeout: 20_000 });
      const d = await dossiersOfGuest();
      expect(d).toHaveLength(1);
      expect(d[0].referred_by_tenant_id).toBe(T.v);
      expect(networkMails()).toHaveLength((await hostAdmins()) + 1);
    } finally {
      await cleanup();
      await pool.query("DELETE FROM rooms WHERE id = $1", [second]);
    }
  });
});
