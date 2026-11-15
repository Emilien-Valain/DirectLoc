import nodemailer from "nodemailer";
import type { TenantConfig } from "@/lib/tenant-context";
import { isDemoTenant } from "@/lib/demo";

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT ?? "587", 10),
  secure: process.env.SMTP_SECURE === "true",
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

const fromAddress = process.env.SMTP_FROM ?? "noreply@directloc.app";

function formatDate(d: Date): string {
  // Dates de séjour stockées en UTC minuit (ADR-0005) : sans timeZone, un serveur à l'ouest de UTC affiche la veille.
  return d.toLocaleDateString("fr-FR", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function nl2br(text: string): string {
  return escapeHtml(text).replace(/\n/g, "<br>");
}

// ─── Template email brandé ──────────────────────────────────────────────────

type EmailLayoutOptions = {
  hotelName: string;
  config?: TenantConfig;
};

function renderEmailLayout(
  { hotelName, config }: EmailLayoutOptions,
  bodyHtml: string,
): string {
  const primary = config?.primaryColor ?? "#1c1917";
  const secondary = config?.secondaryColor ?? "#faf8f5";
  const logoUrl = config?.logoUrl;
  const address = config?.address;
  const phone = config?.phone;
  const contactEmail = config?.email;

  const footerParts: string[] = [];
  if (address) footerParts.push(escapeHtml(address));
  if (phone) footerParts.push(escapeHtml(phone));
  if (contactEmail) footerParts.push(escapeHtml(contactEmail));

  return `
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;600;700&display=swap');
  </style>
</head>
<body style="margin: 0; padding: 0; background-color: ${secondary}; font-family: 'Cormorant Garamond', Georgia, 'Times New Roman', serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: ${secondary};">
    <tr>
      <td align="center" style="padding: 40px 16px;">
        <table role="presentation" width="600" cellspacing="0" cellpadding="0" style="max-width: 600px; width: 100%;">
          <!-- Header -->
          <tr>
            <td style="padding: 32px 40px; text-align: center; border-bottom: 2px solid ${primary};">
              ${logoUrl ? `<img src="${escapeHtml(logoUrl)}" alt="${escapeHtml(hotelName)}" style="max-height: 60px; max-width: 200px; margin-bottom: 12px; display: block; margin-left: auto; margin-right: auto;">` : ""}
              <h1 style="margin: 0; font-size: 28px; font-weight: 600; color: ${primary}; letter-spacing: 0.02em;">
                ${escapeHtml(hotelName)}
              </h1>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="background-color: #ffffff; padding: 40px;">
              ${bodyHtml}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding: 24px 40px; text-align: center; border-top: 1px solid #e5e5e5;">
              ${footerParts.length > 0 ? `<p style="margin: 0 0 8px 0; font-size: 13px; color: #999; line-height: 1.5;">${footerParts.join(" &middot; ")}</p>` : ""}
              <p style="margin: 0; font-size: 12px; color: #bbb;">
                Propuls&eacute; par <a href="https://directloc.app" style="color: #bbb; text-decoration: underline;">DirectLoc</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ─── Helpers d'envoi ────────────────────────────────────────────────────────

type SendOptions = {
  to: string;
  subject: string;
  html: string;
  hotelName: string;
  replyTo?: string;
  /** Tenant concerné : rien ne part pour l'hôtel de démo public (admin ouvert à tous). */
  // Obligatoire : un envoi qui oublie le tenant partirait aussi depuis la démo. null = email plateforme.
  tenantId: string | null;
};

async function sendEmail({ to, subject, html, hotelName, replyTo, tenantId }: SendOptions) {
  if (tenantId && (await isDemoTenant(tenantId))) return;
  await transporter.sendMail({
    from: `${hotelName} <${fromAddress}>`,
    to,
    subject,
    html,
    ...(replyTo ? { replyTo } : {}),
  });
}

// ─── Données de réservation communes ────────────────────────────────────────

type BookingEmailData = {
  guestName: string;
  guestEmail: string;
  roomName: string;
  checkIn: Date;
  checkOut: Date;
  nights: number;
  totalPrice: string;
  /** Lignes d'Extras (ADR-0010), déjà incluses dans `totalPrice`. */
  extras?: EmailExtraLine[];
  hotelName: string;
  config?: TenantConfig;
  tenantId: string;
};

type EmailExtraLine = { label: string; quantity: number; unitPrice: number; total: number };

const euros = (n: number) => n.toFixed(2).replace(".", ",");

/** Une ligne de tableau par Extra (libellé échappé : saisi par l'hôte). */
function renderExtraRows(extras: EmailExtraLine[] = [], cell: string): string {
  return extras
    .map(
      (x) => `
  <tr>
    <td style="${cell} color: #666;">${escapeHtml(x.label)}${x.quantity > 1 ? ` (${x.quantity} &times; ${euros(x.unitPrice)} &euro;)` : ""}</td>
    <td style="${cell} text-align: right;">${x.total === 0 ? "Offert" : `${euros(x.total)} &euro;`}</td>
  </tr>`,
    )
    .join("");
}

function renderBookingSummaryTable(data: {
  roomName: string;
  checkIn: Date;
  checkOut: Date;
  nights: number;
  totalPrice: string;
  extras?: EmailExtraLine[];
}, totalLabel = "Total pay&eacute;"): string {
  const { roomName, checkIn, checkOut, nights, totalPrice, extras } = data;
  return `
<table style="width: 100%; border-collapse: collapse; margin: 24px 0;">
  <tr>
    <td style="padding: 10px 0; border-bottom: 1px solid #e5e5e5; color: #666; font-size: 15px;">Chambre</td>
    <td style="padding: 10px 0; border-bottom: 1px solid #e5e5e5; text-align: right; font-weight: 600; font-size: 15px;">${escapeHtml(roomName)}</td>
  </tr>
  <tr>
    <td style="padding: 10px 0; border-bottom: 1px solid #e5e5e5; color: #666; font-size: 15px;">Arriv&eacute;e</td>
    <td style="padding: 10px 0; border-bottom: 1px solid #e5e5e5; text-align: right; font-size: 15px;">${formatDate(checkIn)}</td>
  </tr>
  <tr>
    <td style="padding: 10px 0; border-bottom: 1px solid #e5e5e5; color: #666; font-size: 15px;">D&eacute;part</td>
    <td style="padding: 10px 0; border-bottom: 1px solid #e5e5e5; text-align: right; font-size: 15px;">${formatDate(checkOut)}</td>
  </tr>
  <tr>
    <td style="padding: 10px 0; border-bottom: 1px solid #e5e5e5; color: #666; font-size: 15px;">Dur&eacute;e</td>
    <td style="padding: 10px 0; border-bottom: 1px solid #e5e5e5; text-align: right; font-size: 15px;">${nights} nuit${nights > 1 ? "s" : ""}</td>
  </tr>${renderExtraRows(extras, "padding: 10px 0; border-bottom: 1px solid #e5e5e5; font-size: 15px;")}
  <tr>
    <td style="padding: 10px 0; color: #666; font-weight: 600; font-size: 15px;">${totalLabel}</td>
    <td style="padding: 10px 0; text-align: right; font-size: 20px; font-weight: 700;">${escapeHtml(totalPrice)} &euro;</td>
  </tr>
</table>`;
}

// ─── 1. Confirmation de réservation (client) ────────────────────────────────

export async function sendBookingConfirmation(data: BookingEmailData & { confirmationMessage?: string }) {
  const { guestName, guestEmail, hotelName, config, confirmationMessage } = data;

  const customMessage = confirmationMessage?.trim()
    ? `<p style="margin: 24px 0; padding: 20px; background-color: ${config?.secondaryColor ?? "#faf8f5"}; border-left: 3px solid ${config?.primaryColor ?? "#1c1917"}; font-size: 15px; line-height: 1.6; color: #333;">${nl2br(confirmationMessage)}</p>`
    : "";

  const body = `
<h2 style="margin: 0 0 16px 0; font-size: 24px; font-weight: 600; color: #1a1a1a;">R&eacute;servation confirm&eacute;e</h2>
<p style="font-size: 15px; color: #333; line-height: 1.6;">Bonjour ${escapeHtml(guestName)},</p>
<p style="font-size: 15px; color: #333; line-height: 1.6;">Votre r&eacute;servation &agrave; <strong>${escapeHtml(hotelName)}</strong> est confirm&eacute;e. Voici le r&eacute;capitulatif :</p>
${renderBookingSummaryTable(data)}
${customMessage}
<p style="font-size: 15px; color: #333; line-height: 1.6;">Nous avons h&acirc;te de vous accueillir !</p>`;

  const html = renderEmailLayout({ hotelName, config }, body);

  await sendEmail({
    tenantId: data.tenantId ?? null,
    to: guestEmail,
    subject: `Confirmation de réservation — ${hotelName}`,
    html,
    hotelName,
    replyTo: config?.email,
  });
}

// ─── 1b. Séjour modifié par l'établissement (client) ───────────────────────

export async function sendBookingModification(data: BookingEmailData) {
  const { guestName, guestEmail, hotelName, config } = data;

  const body = `
<h2 style="margin: 0 0 16px 0; font-size: 24px; font-weight: 600; color: #1a1a1a;">Votre s&eacute;jour a &eacute;t&eacute; modifi&eacute;</h2>
<p style="font-size: 15px; color: #333; line-height: 1.6;">Bonjour ${escapeHtml(guestName)},</p>
<p style="font-size: 15px; color: #333; line-height: 1.6;"><strong>${escapeHtml(hotelName)}</strong> a mis &agrave; jour votre r&eacute;servation. Voici le nouveau r&eacute;capitulatif :</p>
${renderBookingSummaryTable(data, "Total du s&eacute;jour")}
<p style="font-size: 15px; color: #333; line-height: 1.6;">Une question ? R&eacute;pondez simplement &agrave; cet email.</p>`;

  await sendEmail({
    tenantId: data.tenantId ?? null,
    to: guestEmail,
    subject: `Votre réservation a été modifiée — ${hotelName}`,
    html: renderEmailLayout({ hotelName, config }, body),
    hotelName,
    replyTo: config?.email,
  });
}

// ─── 2. Notification admin ──────────────────────────────────────────────────

type AdminNotificationData = BookingEmailData & {
  guestPhone: string | null;
  adminEmail: string;
};

export async function sendAdminNotification(data: AdminNotificationData) {
  const { guestName, guestEmail, guestPhone, roomName, checkIn, checkOut, nights, totalPrice, extras, hotelName, adminEmail, config } = data;

  const body = `
<h2 style="margin: 0 0 16px 0; font-size: 22px; font-weight: 600; color: #1a1a1a;">Nouvelle r&eacute;servation pay&eacute;e</h2>
<table style="width: 100%; border-collapse: collapse;">
  <tr>
    <td style="padding: 8px 0; color: #666; font-size: 15px;">Client</td>
    <td style="padding: 8px 0; text-align: right; font-weight: 600; font-size: 15px;">${escapeHtml(guestName)}</td>
  </tr>
  <tr>
    <td style="padding: 8px 0; color: #666; font-size: 15px;">Email</td>
    <td style="padding: 8px 0; text-align: right; font-size: 15px;">${escapeHtml(guestEmail)}</td>
  </tr>
  ${guestPhone ? `<tr><td style="padding: 8px 0; color: #666; font-size: 15px;">T&eacute;l&eacute;phone</td><td style="padding: 8px 0; text-align: right; font-size: 15px;">${escapeHtml(guestPhone)}</td></tr>` : ""}
  <tr>
    <td style="padding: 8px 0; color: #666; font-size: 15px;">Chambre</td>
    <td style="padding: 8px 0; text-align: right; font-size: 15px;">${escapeHtml(roomName)}</td>
  </tr>
  <tr>
    <td style="padding: 8px 0; color: #666; font-size: 15px;">Dates</td>
    <td style="padding: 8px 0; text-align: right; font-size: 15px;">${formatDate(checkIn)} &rarr; ${formatDate(checkOut)} (${nights} nuit${nights > 1 ? "s" : ""})</td>
  </tr>${renderExtraRows(extras, "padding: 8px 0; font-size: 15px;")}
  <tr>
    <td style="padding: 8px 0; color: #666; font-weight: 600; font-size: 15px;">Montant</td>
    <td style="padding: 8px 0; text-align: right; font-weight: 700; font-size: 18px;">${escapeHtml(totalPrice)} &euro;</td>
  </tr>
</table>`;

  const html = renderEmailLayout({ hotelName, config }, body);

  await sendEmail({
    tenantId: data.tenantId ?? null,
    to: adminEmail,
    subject: `Nouvelle réservation — ${guestName} (${roomName})`,
    html,
    hotelName: `DirectLoc`,
  });
}

// ─── 2b. Alerte admin : paiement reçu sur une réservation annulée ───────────

type PaidAfterCancellationData = BookingEmailData & {
  adminEmail: string;
  stripePaymentId: string;
};

export async function sendPaidAfterCancellationAlert(data: PaidAfterCancellationData) {
  const { guestName, guestEmail, hotelName, config, adminEmail, stripePaymentId } = data;

  const body = `
<h2 style="margin: 0 0 16px 0; font-size: 22px; font-weight: 600; color: #b42318;">Paiement re&ccedil;u sur une r&eacute;servation annul&eacute;e</h2>
<p style="margin: 0 0 16px 0; font-size: 15px; line-height: 1.6;">
  ${escapeHtml(guestName)} (${escapeHtml(guestEmail)}) a pay&eacute; une r&eacute;servation qui avait &eacute;t&eacute; annul&eacute;e entre-temps.
  La r&eacute;servation reste annul&eacute;e : <strong>remboursez le client depuis votre tableau de bord Stripe</strong>
  (paiement <code>${escapeHtml(stripePaymentId)}</code>), ou recr&eacute;ez la r&eacute;servation si la chambre est encore libre.
</p>
${renderBookingSummaryTable(data)}`;

  await sendEmail({
    tenantId: data.tenantId ?? null,
    to: adminEmail,
    subject: `Paiement reçu sur une réservation annulée — remboursez via Stripe (${guestName})`,
    html: renderEmailLayout({ hotelName, config }, body),
    hotelName: `DirectLoc`,
  });
}

// ─── 3. Annulation de réservation (client) ──────────────────────────────────

type CancellationEmailData = {
  guestName: string;
  guestEmail: string;
  roomName: string;
  checkIn: Date;
  checkOut: Date;
  hotelName: string;
  config?: TenantConfig;
  reason: "admin" | "payment_expired";
  tenantId: string;
};

export async function sendBookingCancellation(data: CancellationEmailData) {
  const { guestName, guestEmail, roomName, checkIn, checkOut, hotelName, config, reason } = data;

  const reasonText =
    reason === "admin"
      ? "par l'&eacute;tablissement"
      : "car le paiement n'a pas &eacute;t&eacute; finalis&eacute; dans le d&eacute;lai imparti";

  const body = `
<h2 style="margin: 0 0 16px 0; font-size: 24px; font-weight: 600; color: #1a1a1a;">R&eacute;servation annul&eacute;e</h2>
<p style="font-size: 15px; color: #333; line-height: 1.6;">Bonjour ${escapeHtml(guestName)},</p>
<p style="font-size: 15px; color: #333; line-height: 1.6;">Votre r&eacute;servation &agrave; <strong>${escapeHtml(hotelName)}</strong> a &eacute;t&eacute; annul&eacute;e ${reasonText}.</p>
<table style="width: 100%; border-collapse: collapse; margin: 24px 0;">
  <tr>
    <td style="padding: 10px 0; border-bottom: 1px solid #e5e5e5; color: #666; font-size: 15px;">Chambre</td>
    <td style="padding: 10px 0; border-bottom: 1px solid #e5e5e5; text-align: right; font-size: 15px;">${escapeHtml(roomName)}</td>
  </tr>
  <tr>
    <td style="padding: 10px 0; border-bottom: 1px solid #e5e5e5; color: #666; font-size: 15px;">Arriv&eacute;e pr&eacute;vue</td>
    <td style="padding: 10px 0; border-bottom: 1px solid #e5e5e5; text-align: right; font-size: 15px;">${formatDate(checkIn)}</td>
  </tr>
  <tr>
    <td style="padding: 10px 0; color: #666; font-size: 15px;">D&eacute;part pr&eacute;vu</td>
    <td style="padding: 10px 0; text-align: right; font-size: 15px;">${formatDate(checkOut)}</td>
  </tr>
</table>
<p style="font-size: 15px; color: #333; line-height: 1.6;">Si vous avez des questions, n'h&eacute;sitez pas &agrave; nous contacter.</p>`;

  const html = renderEmailLayout({ hotelName, config }, body);

  await sendEmail({
    tenantId: data.tenantId ?? null,
    to: guestEmail,
    subject: `Réservation annulée — ${hotelName}`,
    html,
    hotelName,
    replyTo: config?.email,
  });
}

// ─── 4. Rappel J-2 avant check-in ──────────────────────────────────────────

type ReminderEmailData = {
  guestName: string;
  guestEmail: string;
  roomName: string;
  checkIn: Date;
  checkOut: Date;
  nights: number;
  hotelName: string;
  config?: TenantConfig;
  tenantId: string;
};

export async function sendCheckInReminder(data: ReminderEmailData) {
  const { guestName, guestEmail, roomName, checkIn, checkOut, nights, hotelName, config } = data;

  const addressBlock = config?.address
    ? `<p style="font-size: 15px; color: #333; line-height: 1.6;"><strong>Adresse :</strong> ${escapeHtml(config.address)}</p>`
    : "";

  const body = `
<h2 style="margin: 0 0 16px 0; font-size: 24px; font-weight: 600; color: #1a1a1a;">Votre s&eacute;jour approche !</h2>
<p style="font-size: 15px; color: #333; line-height: 1.6;">Bonjour ${escapeHtml(guestName)},</p>
<p style="font-size: 15px; color: #333; line-height: 1.6;">Nous vous rappelons votre r&eacute;servation &agrave; <strong>${escapeHtml(hotelName)}</strong> dans 2 jours.</p>
<table style="width: 100%; border-collapse: collapse; margin: 24px 0;">
  <tr>
    <td style="padding: 10px 0; border-bottom: 1px solid #e5e5e5; color: #666; font-size: 15px;">Chambre</td>
    <td style="padding: 10px 0; border-bottom: 1px solid #e5e5e5; text-align: right; font-weight: 600; font-size: 15px;">${escapeHtml(roomName)}</td>
  </tr>
  <tr>
    <td style="padding: 10px 0; border-bottom: 1px solid #e5e5e5; color: #666; font-size: 15px;">Arriv&eacute;e</td>
    <td style="padding: 10px 0; border-bottom: 1px solid #e5e5e5; text-align: right; font-size: 15px;">${formatDate(checkIn)}</td>
  </tr>
  <tr>
    <td style="padding: 10px 0; border-bottom: 1px solid #e5e5e5; color: #666; font-size: 15px;">D&eacute;part</td>
    <td style="padding: 10px 0; border-bottom: 1px solid #e5e5e5; text-align: right; font-size: 15px;">${formatDate(checkOut)}</td>
  </tr>
  <tr>
    <td style="padding: 10px 0; color: #666; font-size: 15px;">Dur&eacute;e</td>
    <td style="padding: 10px 0; text-align: right; font-size: 15px;">${nights} nuit${nights > 1 ? "s" : ""}</td>
  </tr>
</table>
${addressBlock}
<p style="font-size: 15px; color: #333; line-height: 1.6;">&Agrave; tr&egrave;s bient&ocirc;t !</p>`;

  const html = renderEmailLayout({ hotelName, config }, body);

  await sendEmail({
    tenantId: data.tenantId ?? null,
    to: guestEmail,
    subject: `Rappel : votre séjour dans 2 jours — ${hotelName}`,
    html,
    hotelName,
    replyTo: config?.email,
  });
}

// ─── 5. Remerciement post-séjour ────────────────────────────────────────────

type PostStayEmailData = {
  guestName: string;
  guestEmail: string;
  hotelName: string;
  config?: TenantConfig;
  tenantId: string;
};

export async function sendPostStayThankYou(data: PostStayEmailData) {
  const { guestName, guestEmail, hotelName, config } = data;

  const customMessage = config?.postStayMessage?.trim()
    ? `<p style="margin: 24px 0; padding: 20px; background-color: ${config.secondaryColor ?? "#faf8f5"}; border-left: 3px solid ${config.primaryColor ?? "#1c1917"}; font-size: 15px; line-height: 1.6; color: #333;">${nl2br(config.postStayMessage)}</p>`
    : "";

  const reviewBlock = config?.reviewUrl
    ? `<p style="text-align: center; margin: 24px 0;">
        <a href="${escapeHtml(config.reviewUrl)}" style="display: inline-block; padding: 12px 28px; background-color: ${config.primaryColor ?? "#1c1917"}; color: #ffffff; text-decoration: none; font-size: 15px; font-weight: 600; letter-spacing: 0.02em;">
          Laisser un avis
        </a>
      </p>`
    : "";

  const body = `
<h2 style="margin: 0 0 16px 0; font-size: 24px; font-weight: 600; color: #1a1a1a;">Merci pour votre s&eacute;jour !</h2>
<p style="font-size: 15px; color: #333; line-height: 1.6;">Bonjour ${escapeHtml(guestName)},</p>
<p style="font-size: 15px; color: #333; line-height: 1.6;">Nous esp&eacute;rons que votre s&eacute;jour &agrave; <strong>${escapeHtml(hotelName)}</strong> a &eacute;t&eacute; agr&eacute;able.</p>
${customMessage}
${reviewBlock}
<p style="font-size: 15px; color: #333; line-height: 1.6;">Nous esp&eacute;rons avoir le plaisir de vous revoir bient&ocirc;t.</p>`;

  const html = renderEmailLayout({ hotelName, config }, body);

  await sendEmail({
    tenantId: data.tenantId ?? null,
    to: guestEmail,
    subject: `Merci pour votre séjour — ${hotelName}`,
    html,
    hotelName,
    replyTo: config?.email,
  });
}

// ─── 6. Reset mot de passe ──────────────────────────────────────────────────

type PasswordResetEmailData = {
  userName: string;
  userEmail: string;
  resetUrl: string;
  hotelName?: string;
  config?: TenantConfig;
  tenantId?: string;
};

export async function sendPasswordResetEmail(data: PasswordResetEmailData) {
  const { userName, userEmail, resetUrl, hotelName, config } = data;
  const displayName = hotelName ?? "DirectLoc";

  const primary = config?.primaryColor ?? "#1c1917";

  const body = `
<h2 style="margin: 0 0 16px 0; font-size: 24px; font-weight: 600; color: #1a1a1a;">R&eacute;initialisation du mot de passe</h2>
<p style="font-size: 15px; color: #333; line-height: 1.6;">Bonjour ${escapeHtml(userName)},</p>
<p style="font-size: 15px; color: #333; line-height: 1.6;">Vous avez demand&eacute; la r&eacute;initialisation de votre mot de passe. Cliquez sur le bouton ci-dessous :</p>
<p style="text-align: center; margin: 32px 0;">
  <a href="${escapeHtml(resetUrl)}" style="display: inline-block; padding: 14px 32px; background-color: ${primary}; color: #ffffff; text-decoration: none; font-size: 16px; font-weight: 600; letter-spacing: 0.02em;">
    R&eacute;initialiser mon mot de passe
  </a>
</p>
<p style="font-size: 13px; color: #999; line-height: 1.5;">Ce lien expire dans 1 heure. Si vous n'avez pas demand&eacute; cette r&eacute;initialisation, ignorez cet email.</p>`;

  const html = renderEmailLayout({ hotelName: displayName, config }, body);

  await sendEmail({
    tenantId: data.tenantId ?? null,
    to: userEmail,
    subject: `Réinitialisation de mot de passe — ${displayName}`,
    html,
    hotelName: displayName,
  });
}

// ─── Site vitrine : demande de rappel d'un hébergeur prospect ───────────────

export async function sendCallbackRequest(data: { name: string; phone: string; place: string }) {
  const to = process.env.OPERATOR_EMAIL ?? fromAddress;
  const html = `<p>Demande de rappel depuis directloc.app :</p>
<ul>
  <li>Nom : <strong>${escapeHtml(data.name)}</strong></li>
  <li>Téléphone : <strong>${escapeHtml(data.phone)}</strong></li>
  ${data.place ? `<li>Hébergement / commune : ${escapeHtml(data.place)}</li>` : ""}
</ul>`;
  await sendEmail({ to, subject: `Rappel demandé — ${data.name}`, html, hotelName: "DirectLoc", tenantId: null });
}
