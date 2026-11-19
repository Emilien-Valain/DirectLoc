import { test, expect, type Page } from "@playwright/test";
import fs from "fs";
import path from "path";
import { Pool } from "pg";
import { startSmtpSink } from "../helpers/smtp-sink";
import { mailBody } from "../helpers/mail-body";
import { deleteRoomsByName, insertHiddenRoom } from "../helpers/intake";

/**
 * Spécification : Tests de non-régression > Chambres — infos pratiques (étage, code,
 * wifi + infos libres) et leurs variables dans les emails.
 */

const ctx = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "e2e", ".auth", "test-context.json"), "utf-8"),
) as { tenantId: string };

const ROOM = "Chambre Infos Test";
const OTHER = "Chambre Infos Autre";
const TAG = `roominfo-${Date.now()}`;
let pool: Pool;
let roomId: string;
let otherId: string;

test.use({ extraHTTPHeaders: { "x-forwarded-for": "10.10.0.23" } });

const info = async (id: string) => (await pool.query("SELECT info FROM rooms WHERE id = $1", [id])).rows[0].info;
const save = (page: Page) => page.getByRole("button", { name: "Enregistrer" }).first().click();
const customRows = (page: Page) => page.getByTestId("custom-info-row");

test.describe("Chambres — infos pratiques", () => {
  test.beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await deleteRoomsByName(ctx.tenantId, ROOM);
    await deleteRoomsByName(ctx.tenantId, OTHER);
    roomId = await insertHiddenRoom(ctx.tenantId, ROOM);
    otherId = await insertHiddenRoom(ctx.tenantId, OTHER);
  });
  test.afterEach(async () => {
    await pool.query("UPDATE rooms SET info = '[]', email_message = NULL, active = false WHERE id = ANY($1)", [[roomId, otherId]]);
    await pool.query("DELETE FROM bookings WHERE guest_email LIKE $1", [`${TAG}-%`]);
  });
  test.afterAll(async () => {
    await deleteRoomsByName(ctx.tenantId, ROOM);
    await deleteRoomsByName(ctx.tenantId, OTHER);
    await pool.end();
  });

  test("champs proposés avec leur variable ; info libre ajoutée, enregistrée, relue puis retirée", async ({ page }) => {
    await page.goto(`/admin/chambres/${roomId}/edit`);
    const box = page.getByRole("group", { name: "Infos pratiques" });
    for (const v of ["{etage}", "{code_acces}", "{wifi}", "{wifi_mdp}"]) {
      await expect(box.getByTestId("info-variable").filter({ hasText: v })).toBeVisible();
    }
    await box.getByLabel("Étage").fill("2e étage");
    await box.getByLabel("Mot de passe Wi-Fi").fill("soleil2027");
    await expect(customRows(page)).toHaveCount(0);
    await box.getByRole("button", { name: "+ Ajouter une info" }).click();
    await customRows(page).getByLabel("Nom de l'info").fill("Code du portail");
    // La variable s'affiche pendant la saisie du nom.
    await expect(customRows(page).getByTestId("info-variable")).toHaveText("{code_du_portail}");
    await customRows(page).getByLabel("Valeur").fill("1984");
    await save(page);
    await expect(page).toHaveURL(/\/admin\/chambres$/);
    expect(await info(roomId)).toEqual([
      { key: "etage", label: "Étage", value: "2e étage" },
      { key: "wifi_mdp", label: "Mot de passe Wi-Fi", value: "soleil2027" },
      { key: "code_du_portail", label: "Code du portail", value: "1984" },
    ]);

    await page.goto(`/admin/chambres/${roomId}/edit`);
    await expect(box.getByLabel("Étage")).toHaveValue("2e étage");
    await expect(customRows(page).getByLabel("Nom de l'info")).toHaveValue("Code du portail");
    await expect(customRows(page).getByLabel("Valeur")).toHaveValue("1984");

    await page.getByRole("button", { name: "Retirer l'info Code du portail" }).click();
    await box.getByLabel("Étage").fill("");
    await save(page);
    await expect(page).toHaveURL(/\/admin\/chambres$/);
    expect(await info(roomId)).toEqual([{ key: "wifi_mdp", label: "Mot de passe Wi-Fi", value: "soleil2027" }]);
  });

  test("refus : nom réservé, info en double, valeur manquante → message sur la ligne, rien d'enregistré, saisie gardée", async ({ page }) => {
    await page.goto(`/admin/chambres/${roomId}/edit`);
    const add = page.getByRole("button", { name: "+ Ajouter une info" });
    await add.click();
    await customRows(page).nth(0).getByLabel("Nom de l'info").fill("Client");
    await customRows(page).nth(0).getByLabel("Valeur").fill("x");
    await save(page);
    await expect(page.getByText("{client} est déjà une variable des emails").first()).toBeVisible();
    await expect(customRows(page).nth(0).getByLabel("Nom de l'info")).toHaveAttribute("aria-invalid", "true");

    await customRows(page).nth(0).getByLabel("Nom de l'info").fill("étage");
    await save(page);
    await expect(page.getByText("Une autre info donne déjà la variable {etage}").first()).toBeVisible();

    await customRows(page).nth(0).getByLabel("Nom de l'info").fill("Parking");
    await customRows(page).nth(0).getByLabel("Valeur").fill("");
    await save(page);
    await expect(page.getByText("Indiquez la valeur, ou retirez cette info").first()).toBeVisible();
    await expect(customRows(page).nth(0).getByLabel("Nom de l'info")).toHaveValue("Parking");
    expect(await info(roomId)).toEqual([]);
  });

  test("email : variables des infos remplacées et échappées ; info d'une autre chambre vide", async ({ request }) => {
    await pool.query("UPDATE rooms SET info = $2::jsonb, email_message = $3 WHERE id = $1", [
      roomId,
      JSON.stringify([
        { key: "etage", label: "Étage", value: "2e <b>étage</b>" },
        { key: "code_du_portail", label: "Code du portail", value: "1984" },
      ]),
      "Étage {etage}, portail {code_du_portail}, wifi [{wifi}], parking [{parking}]",
    ]);
    await pool.query("UPDATE rooms SET info = $2::jsonb WHERE id = $1", [
      otherId,
      JSON.stringify([{ key: "parking", label: "Parking", value: "place 4" }]),
    ]);
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(new Date());
    await pool.query(
      `INSERT INTO bookings (tenant_id, room_id, check_in, check_out, total_price, status, guest_name, guest_email, guest_count, source, created_at)
       VALUES ($1, $2, $3::date + 2, $3::date + 4, '200.00', 'confirmed', 'Client Infos', $4, 2, 'manual', now() - interval '30 days')`,
      [ctx.tenantId, roomId, today, `${TAG}-due@example.com`],
    );

    const sink = await startSmtpSink();
    try {
      const res = await request.get("/api/cron/booking-emails", { headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` } });
      expect(res.status()).toBe(200);
      const mail = () => sink.mails.find((m) => m.to.includes(`${TAG}-due@example.com`));
      await expect.poll(() => !!mail(), { timeout: 10_000 }).toBe(true);
      const body = mailBody(mail()!);
      expect(body).toContain("Étage 2e &lt;b&gt;étage&lt;/b&gt;, portail 1984, wifi [], parking []");
      expect(body).not.toContain("<b>étage</b>");
    } finally {
      await sink.stop();
    }
  });
});
