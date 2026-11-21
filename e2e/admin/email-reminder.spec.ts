import { test, expect } from "@playwright/test";
import fs from "fs";
import path from "path";
import { Pool } from "pg";
import { deleteOrphanDossiers, insertDossier } from "../helpers/dossier";
import { startSmtpSink } from "../helpers/smtp-sink";
import { mailBody, mailSubject } from "../helpers/mail-body";
import { deleteRoomsByName, insertHiddenRoom } from "../helpers/intake";

/**
 * Spécification : Tests de non-régression > Emails — rappel avant l'arrivée
 * réglable, message par chambre et variables ({client}, {lits}…).
 */

const ctx = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "e2e", ".auth", "test-context.json"), "utf-8"),
) as { tenantId: string; apiRoomId: string };

const ROOM = "Chambre Rappel Test";
const TAG = `reminder-${Date.now()}`;
let pool: Pool;
let roomId: string;

test.use({ extraHTTPHeaders: { "x-forwarded-for": "10.10.0.22" } });

/** Aujourd'hui à Paris + n jours, en YYYY-MM-DD. */
const inDays = (n: number) => {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(new Date());
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

async function setConfig(patch: Record<string, unknown>) {
  await pool.query("UPDATE tenants SET config = config || $2::jsonb WHERE id = $1", [ctx.tenantId, JSON.stringify(patch)]);
}
async function resetConfig() {
  await pool.query("UPDATE tenants SET config = config - 'reminderDaysBefore' - 'reminderMessage' WHERE id = $1", [ctx.tenantId]);
}

async function insertBooking(label: string, checkIn: string, createdAgo: string) {
  const { rows } = await pool.query(
    `INSERT INTO bookings (tenant_id, room_id, check_in, check_out, total_price, status, guest_name, guest_email, guest_count, source, created_at, dossier_id)
     VALUES ($1, $2, $3::date, $3::date + 2, '200.00', 'confirmed', $4, $5, 3, 'manual', now() - $6::interval, $7) RETURNING id`,
    [ctx.tenantId, roomId, checkIn, `Client ${label}`, `${TAG}-${label}@example.com`, createdAgo, await insertDossier(pool, ctx.tenantId)],
  );
  return rows[0].id as string;
}

async function runCron(request: import("@playwright/test").APIRequestContext) {
  const res = await request.get("/api/cron/booking-emails", {
    headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
  });
  expect(res.status()).toBe(200);
  return res.json();
}

test.describe("Emails — rappel avant l'arrivée et message par chambre", () => {
  test.beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await deleteRoomsByName(ctx.tenantId, ROOM);
    roomId = await insertHiddenRoom(ctx.tenantId, ROOM);
  });
  test.afterEach(async () => {
    await pool.query("DELETE FROM bookings WHERE guest_email LIKE $1", [`${TAG}-%`]);
    await deleteOrphanDossiers(pool);
    await resetConfig();
  });
  test.afterAll(async () => {
    await deleteRoomsByName(ctx.tenantId, ROOM);
    await pool.end();
  });

  // ─── Réglages ────────────────────────────────────────────────────────────────

  test("rappel : 2 jours par défaut ; 7 jours + message enregistrés et relus", async ({ page }) => {
    await page.goto("/admin/parametres?tab=email");
    await expect(page.locator("#email-reminder-days")).toHaveValue("2");
    await page.locator("#email-reminder-days").fill("7");
    await page.locator("#email-reminder").fill("À bientôt {client} !");
    await page.locator("section", { has: page.locator("#email-reminder") }).locator('button[type="submit"]').click();
    await expect(page.getByText("mis à jour avec succès")).toBeVisible();
    await page.reload();
    await expect(page.locator("#email-reminder-days")).toHaveValue("7");
    await expect(page.locator("#email-reminder")).toHaveValue("À bientôt {client} !");
  });

  test("rappel : délai hors bornes (-1, 31, 2,5) refusé, valeur enregistrée inchangée", async ({ page }) => {
    await page.goto("/admin/parametres?tab=email");
    const days = page.locator("#email-reminder-days");
    // Contourne min/max du navigateur pour exercer la validation serveur.
    await days.evaluate((el) => ((el as HTMLInputElement).form!.noValidate = true));
    for (const v of ["-1", "31", "2.5"]) {
      await days.fill(v);
      await page.locator("section", { has: days }).locator('button[type="submit"]').click();
      await expect(page.getByText("Rappel : un nombre de jours entre 0 et 30").first()).toBeVisible();
      await expect(days).toHaveAttribute("aria-invalid", "true");
    }
    await page.reload();
    await expect(days).toHaveValue("2");
  });

  test("la liste des variables est affichée", async ({ page }) => {
    await page.goto("/admin/parametres?tab=email");
    await page.getByText("Variables : personnaliser selon le client et la chambre").click();
    await expect(page.getByText("{lits}", { exact: true })).toBeVisible();
    await expect(page.getByText("{voyageurs}", { exact: true })).toBeVisible();
  });

  test("fiche chambre : nombre de lits enregistré ; 0 lit refusé ; aucun réglage d'email dans la fiche", async ({ page }) => {
    await pool.query("UPDATE rooms SET email_message = 'Code porte : 1234', info = $2::jsonb WHERE id = $1", [
      roomId,
      JSON.stringify([{ key: "etage", label: "Étage", value: "2e" }]),
    ]);
    await page.goto(`/admin/chambres/${roomId}/edit`);
    // Les emails se règlent dans Paramètres → Emails, jamais depuis la fiche chambre.
    await expect(page.locator("textarea[name='messageEmail']")).toHaveCount(0);
    await expect(page.getByText("Infos pratiques")).toHaveCount(0);
    await expect(page.getByText("Variables : personnaliser selon le client et la chambre")).toHaveCount(0);

    await page.locator("input[name='lits']").fill("0");
    await page.locator("input[name='lits']").evaluate((el) => ((el as HTMLInputElement).form!.noValidate = true));
    await page.getByRole("button", { name: "Enregistrer" }).first().click();
    await expect(page.getByText("Doit être supérieur à 0").first()).toBeVisible();

    await page.locator("input[name='lits']").fill("3");
    await page.getByRole("button", { name: "Enregistrer" }).first().click();
    await expect(page).toHaveURL(/\/admin\/chambres$/);
    await page.goto(`/admin/chambres/${roomId}/edit`);
    await expect(page.locator("input[name='lits']")).toHaveValue("3");

    // Vider le nombre de lits le remet à « non renseigné ».
    await page.locator("input[name='lits']").fill("");
    await page.getByRole("button", { name: "Enregistrer" }).first().click();
    await expect(page).toHaveURL(/\/admin\/chambres$/);
    const { rows } = await pool.query("SELECT beds, email_message, info FROM rooms WHERE id = $1", [roomId]);
    expect(rows[0].beds).toBeNull();
    // Enregistrer la fiche ne touche ni au message ni aux infos réglés dans Emails.
    expect(rows[0].email_message).toBe("Code porte : 1234");
    expect(rows[0].info).toEqual([{ key: "etage", label: "Étage", value: "2e" }]);
    // La chambre de test reste inactive (insertHiddenRoom) : on ne la réactive pas.
    await pool.query("UPDATE rooms SET active = false, email_message = NULL, info = '[]' WHERE id = $1", [roomId]);
  });

  // ─── Envoi par le cron ───────────────────────────────────────────────────────

  test("J-7 : le rappel part avec le message général et celui de la chambre, variables remplacées et échappées", async ({ request }) => {
    await setConfig({ reminderDaysBefore: 7, reminderMessage: "Hâte de vous voir, {client} ({voyageurs} pers.) <script>x</script>" });
    await pool.query("UPDATE rooms SET beds = 3, email_message = 'Chambre {chambre} : {lits} lits' WHERE id = $1", [roomId]);
    await insertBooking("due", inDays(7), "30 days");
    const lateId = await insertBooking("late", inDays(7), "1 hour"); // réservée après le moment du rappel
    // Entre minuit Paris et minuit UTC, « il y a 1 h » tombe encore avant le moment du rappel
    // (check_in − 7 j, minuit UTC) : on force created_at juste après ce moment.
    await pool.query(
      "UPDATE bookings SET created_at = GREATEST(created_at, check_in - interval '7 days' + interval '1 minute') WHERE id = $1",
      [lateId],
    );
    await insertBooking("far", inDays(8), "30 days"); // pas encore

    const sink = await startSmtpSink();
    try {
      await runCron(request);
      const mailTo = (label: string) => sink.mails.find((m) => m.to.includes(`${TAG}-${label}@example.com`));
      await expect.poll(() => !!mailTo("due"), { timeout: 10_000 }).toBe(true);
      const mail = mailTo("due")!;
      expect(mailSubject(mail)).toContain("dans 7 jours");
      const body = mailBody(mail);
      expect(body).toContain("Hâte de vous voir, Client due (3 pers.)");
      expect(body).toContain("&lt;script&gt;");
      expect(body).not.toContain("<script>x</script>");
      expect(body).toContain(`Chambre ${ROOM} : 3 lits`);
      expect(mailTo("late")).toBeUndefined();
      expect(mailTo("far")).toBeUndefined();

      // Envoyé une seule fois.
      const before = sink.mails.length;
      await runCron(request);
      expect(sink.mails.filter((m) => m.to.includes(`${TAG}-due@example.com`))).toHaveLength(1);
      expect(sink.mails.length).toBeGreaterThanOrEqual(before);
    } finally {
      await sink.stop();
      await pool.query("UPDATE rooms SET beds = NULL, email_message = NULL WHERE id = $1", [roomId]);
    }
  });

  test("rappel désactivé (0) : aucun email ; défaut (2) : part à J-2, « dans 2 jours »", async ({ request }) => {
    await setConfig({ reminderDaysBefore: 0 });
    await insertBooking("off", inDays(2), "30 days");
    const sink = await startSmtpSink();
    try {
      await runCron(request);
      expect(sink.mails.find((m) => m.to.includes(`${TAG}-off@example.com`))).toBeUndefined();

      await resetConfig();
      await runCron(request);
      const mailTo = () => sink.mails.find((m) => m.to.includes(`${TAG}-off@example.com`));
      await expect.poll(() => !!mailTo(), { timeout: 10_000 }).toBe(true);
      expect(mailSubject(mailTo()!)).toContain("dans 2 jours");
    } finally {
      await sink.stop();
    }
  });
});
