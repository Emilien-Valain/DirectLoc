import nodemailer from "nodemailer";
import type { TenantConfig } from "@/lib/tenant-context";
import { isDemoTenant } from "@/lib/demo";
import { emailVariables, fillTemplate, type EmailTemplateContext } from "@/lib/email-template";

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

/** Ce que les messages personnalisés peuvent citer en plus du séjour ({voyageurs}, {lits}…). */
type MessageContext = {
  guestFirstName?: string;
  roomInfo?: Record<string, string>;
  guestCount?: number;
  roomCapacity?: number;
  roomBeds?: number | null;
  /** Message propre à la chambre (rooms.email_message). */
  roomMessage?: string | null;
};

type BookingEmailData = MessageContext & {
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

/**
 * Message saisi par l'hôte, variables remplacées puis échappé, dans l'encadré
 * aux couleurs de l'établissement. Vide → rien.
 */
function renderCustomMessage(
  text: string | null | undefined,
  data: Omit<EmailTemplateContext, "hotelName"> & { hotelName: string; config?: TenantConfig },
): string {
  if (!text?.trim()) return "";
  const filled = fillTemplate(text.trim(), emailVariables(data));
  return `<p style="margin: 24px 0; padding: 20px; background-color: ${data.config?.secondaryColor ?? "#faf8f5"}; border-left: 3px solid ${data.config?.primaryColor ?? "#1c1917"}; font-size: 15px; line-height: 1.6; color: #333;">${nl2br(filled)}</p>`;
}

// ─── Données d'un Dossier (ADR-0012) : un email pour toutes ses chambres ─────

/** Une chambre du Dossier telle que l'email l'affiche. */
export type RoomEmailData = MessageContext & {
  roomName: string;
  /** Prix de la chambre, options incluses (« 270.00 »). */
  totalPrice: string;
  extras?: EmailExtraLine[];
};

/** Ce qu'un email par Dossier affiche : le séjour commun + une entrée par chambre non annulée. */
export type DossierEmailData = {
  guestName: string;
  guestFirstName?: string;
  guestEmail: string;
  checkIn: Date;
  checkOut: Date;
  nights: number;
  hotelName: string;
  config?: TenantConfig;
  tenantId: string;
  rooms: RoomEmailData[];
  /** Somme des chambres listées. */
  totalPrice: string;
};

const stayOf = (d: DossierEmailData) => ({
  guestName: d.guestName,
  guestFirstName: d.guestFirstName,
  checkIn: d.checkIn,
  checkOut: d.checkOut,
  nights: d.nights,
  hotelName: d.hotelName,
  config: d.config,
});

/** Contexte des messages généraux de l'hôte : une chambre = comme avant ; plusieurs = noms joints, personnes et lits additionnés. */
function generalContext(d: DossierEmailData) {
  if (d.rooms.length === 1) return { ...stayOf(d), ...d.rooms[0] };
  const sum = (f: (r: RoomEmailData) => number | null | undefined) =>
    d.rooms.every((r) => f(r) != null) ? d.rooms.reduce((a, r) => a + (f(r) as number), 0) : undefined;
  // Infos pratiques : pour chaque clé, la première valeur renseignée (les messages de chambre voient les leurs).
  const roomInfo: Record<string, string> = {};
  for (const r of d.rooms) for (const [k, v] of Object.entries(r.roomInfo ?? {})) if (v && !roomInfo[k]) roomInfo[k] = v;
  for (const r of d.rooms) for (const k of Object.keys(r.roomInfo ?? {})) roomInfo[k] ??= "";
  return {
    ...stayOf(d),
    roomName: d.rooms.map((r) => r.roomName).join(", "),
    guestCount: sum((r) => r.guestCount),
    roomCapacity: sum((r) => r.roomCapacity),
    roomBeds: sum((r) => r.roomBeds) ?? null,
    roomInfo,
  };
}

/** Message propre à chaque chambre, avec les variables de CETTE chambre. */
const renderRoomMessages = (d: DossierEmailData) =>
  d.rooms.map((r) => renderCustomMessage(r.roomMessage, { ...stayOf(d), ...r })).join("");

const persons = (n?: number) => (n ? ` (${n} pers.)` : "");

/** Récapitulatif avec prix : une chambre = le tableau historique ; plusieurs = une ligne (+ options) par chambre. */
function renderDossierSummary(d: DossierEmailData, totalLabel = "Total pay&eacute;"): string {
  if (d.rooms.length === 1) {
    return renderBookingSummaryTable({ ...stayOf(d), ...d.rooms[0], totalPrice: d.totalPrice }, totalLabel);
  }
  const cell = "padding: 10px 0; border-bottom: 1px solid #e5e5e5; font-size: 15px;";
  return `
<table style="width: 100%; border-collapse: collapse; margin: 24px 0;">
  <tr>
    <td style="${cell} color: #666;">Arriv&eacute;e</td>
    <td style="${cell} text-align: right;">${formatDate(d.checkIn)}</td>
  </tr>
  <tr>
    <td style="${cell} color: #666;">D&eacute;part</td>
    <td style="${cell} text-align: right;">${formatDate(d.checkOut)}</td>
  </tr>
  <tr>
    <td style="${cell} color: #666;">Dur&eacute;e</td>
    <td style="${cell} text-align: right;">${d.nights} nuit${d.nights > 1 ? "s" : ""}</td>
  </tr>${d.rooms
    .map(
      (r) => `
  <tr>
    <td style="${cell} font-weight: 600;">${escapeHtml(r.roomName)}${persons(r.guestCount)}</td>
    <td style="${cell} text-align: right; font-weight: 600;">${escapeHtml(r.totalPrice)} &euro;</td>
  </tr>${renderExtraRows(r.extras, `${cell} padding-left: 16px;`)}`,
    )
    .join("")}
  <tr>
    <td style="padding: 10px 0; color: #666; font-weight: 600; font-size: 15px;">${totalLabel}</td>
    <td style="padding: 10px 0; text-align: right; font-size: 20px; font-weight: 700;">${escapeHtml(d.totalPrice)} &euro;</td>
  </tr>
</table>`;
}

// ─── 1. Confirmation de réservation (client) ────────────────────────────────

export async function sendBookingConfirmation(data: DossierEmailData & { confirmationMessage?: string }) {
  const { guestName, guestEmail, hotelName, config, confirmationMessage } = data;

  const customMessage = renderCustomMessage(confirmationMessage, generalContext(data)) + renderRoomMessages(data);

  const body = `
<h2 style="margin: 0 0 16px 0; font-size: 24px; font-weight: 600; color: #1a1a1a;">R&eacute;servation confirm&eacute;e</h2>
<p style="font-size: 15px; color: #333; line-height: 1.6;">Bonjour ${escapeHtml(guestName)},</p>
<p style="font-size: 15px; color: #333; line-height: 1.6;">Votre r&eacute;servation &agrave; <strong>${escapeHtml(hotelName)}</strong> est confirm&eacute;e. Voici le r&eacute;capitulatif :</p>
${renderDossierSummary(data)}
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

/** « Une question ? » vers le contact de l'hôte : l'email part d'une adresse noreply, on ne propose jamais d'y répondre. */
export function renderQuestionLine(config?: TenantConfig): string {
  const p = '<p style="font-size: 15px; color: #333; line-height: 1.6;">';
  if (config?.email) {
    const e = escapeHtml(config.email);
    return `${p}Une question ? &Eacute;crivez-nous &agrave; <a href="mailto:${e}" style="color: inherit;">${e}</a>.</p>`;
  }
  if (config?.phone) return `${p}Une question ? Appelez-nous au ${escapeHtml(config.phone)}.</p>`;
  return "";
}

export async function sendBookingModification(data: BookingEmailData) {
  const { guestName, guestEmail, hotelName, config } = data;

  const body = `
<h2 style="margin: 0 0 16px 0; font-size: 24px; font-weight: 600; color: #1a1a1a;">Votre s&eacute;jour a &eacute;t&eacute; modifi&eacute;</h2>
<p style="font-size: 15px; color: #333; line-height: 1.6;">Bonjour ${escapeHtml(guestName)},</p>
<p style="font-size: 15px; color: #333; line-height: 1.6;"><strong>${escapeHtml(hotelName)}</strong> a mis &agrave; jour votre r&eacute;servation. Voici le nouveau r&eacute;capitulatif :</p>
${renderBookingSummaryTable(data, "Total du s&eacute;jour")}
${renderQuestionLine(config)}`;

  await sendEmail({
    tenantId: data.tenantId ?? null,
    to: guestEmail,
    subject: `Votre réservation a été modifiée — ${hotelName}`,
    html: renderEmailLayout({ hotelName, config }, body),
    hotelName,
    replyTo: config?.email,
  });
}

/** Dossier modifié par l'hôte (dates de toutes les chambres, chambre ajoutée) : le nouveau récapitulatif. */
export async function sendDossierModification(data: DossierEmailData) {
  const { guestName, guestEmail, hotelName, config } = data;
  const body = `
<h2 style="margin: 0 0 16px 0; font-size: 24px; font-weight: 600; color: #1a1a1a;">Votre s&eacute;jour a &eacute;t&eacute; modifi&eacute;</h2>
<p style="font-size: 15px; color: #333; line-height: 1.6;">Bonjour ${escapeHtml(guestName)},</p>
<p style="font-size: 15px; color: #333; line-height: 1.6;"><strong>${escapeHtml(hotelName)}</strong> a mis &agrave; jour votre r&eacute;servation. Voici le nouveau r&eacute;capitulatif :</p>
${renderDossierSummary(data, "Total du s&eacute;jour")}
${renderQuestionLine(config)}`;

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

type AdminNotificationData = DossierEmailData & {
  guestPhone: string | null;
  adminEmail: string;
};

export async function sendAdminNotification(data: AdminNotificationData) {
  const { guestName, guestEmail, guestPhone, checkIn, checkOut, nights, totalPrice, rooms, hotelName, adminEmail, config } = data;
  const row = "padding: 8px 0; font-size: 15px;";
  const roomRows =
    rooms.length === 1
      ? `<tr>
    <td style="${row} color: #666;">Chambre</td>
    <td style="${row} text-align: right;">${escapeHtml(rooms[0].roomName)}</td>
  </tr>`
      : "";

  const body = `
<h2 style="margin: 0 0 16px 0; font-size: 22px; font-weight: 600; color: #1a1a1a;">Nouvelle r&eacute;servation pay&eacute;e</h2>
<table style="width: 100%; border-collapse: collapse;">
  <tr>
    <td style="${row} color: #666;">Client</td>
    <td style="${row} text-align: right; font-weight: 600;">${escapeHtml(guestName)}</td>
  </tr>
  <tr>
    <td style="${row} color: #666;">Email</td>
    <td style="${row} text-align: right;">${escapeHtml(guestEmail)}</td>
  </tr>
  ${guestPhone ? `<tr><td style="${row} color: #666;">T&eacute;l&eacute;phone</td><td style="${row} text-align: right;">${escapeHtml(guestPhone)}</td></tr>` : ""}
  ${roomRows}
  <tr>
    <td style="${row} color: #666;">Dates</td>
    <td style="${row} text-align: right;">${formatDate(checkIn)} &rarr; ${formatDate(checkOut)} (${nights} nuit${nights > 1 ? "s" : ""})</td>
  </tr>${rooms
    .map((r) =>
      rooms.length === 1
        ? renderExtraRows(r.extras, row)
        : `
  <tr>
    <td style="${row} font-weight: 600;">${escapeHtml(r.roomName)}${persons(r.guestCount)}</td>
    <td style="${row} text-align: right;">${escapeHtml(r.totalPrice)} &euro;</td>
  </tr>${renderExtraRows(r.extras, `${row} padding-left: 16px;`)}`,
    )
    .join("")}
  <tr>
    <td style="${row} color: #666; font-weight: 600;">Montant</td>
    <td style="${row} text-align: right; font-weight: 700; font-size: 18px;">${escapeHtml(totalPrice)} &euro;</td>
  </tr>
</table>`;

  const html = renderEmailLayout({ hotelName, config }, body);

  await sendEmail({
    tenantId: data.tenantId ?? null,
    to: adminEmail,
    subject: `Nouvelle réservation — ${guestName} (${rooms.map((r) => r.roomName).join(", ")})`,
    html,
    hotelName: `DirectLoc`,
  });
}

// ─── 2b. Alerte admin : paiement reçu sur une réservation annulée ───────────

type PaidAfterCancellationData = BookingEmailData & {
  adminEmail: string;
  stripePaymentId: string;
  /**
   * Dossier en partie annulé (ADR-0012) : chambres annulées par l'hôte pendant le paiement.
   * Les autres sont confirmées ; seule la part de ces chambres est à rembourser.
   */
  cancelledRooms?: { name: string; total: string }[];
};

export async function sendPaidAfterCancellationAlert(data: PaidAfterCancellationData) {
  const { guestName, guestEmail, hotelName, config, adminEmail, stripePaymentId, cancelledRooms } = data;
  const partial = cancelledRooms && cancelledRooms.length > 0;

  const body = partial
    ? `
<h2 style="margin: 0 0 16px 0; font-size: 22px; font-weight: 600; color: #b42318;">Paiement re&ccedil;u : une partie du s&eacute;jour est annul&eacute;e</h2>
<p style="margin: 0 0 16px 0; font-size: 15px; line-height: 1.6;">
  ${escapeHtml(guestName)} (${escapeHtml(guestEmail)}) a pay&eacute; tout son s&eacute;jour, mais
  ${cancelledRooms.map((r) => `<strong>${escapeHtml(r.name)}</strong> (${escapeHtml(r.total)} &euro;)`).join(", ")}
  ${cancelledRooms.length > 1 ? "avaient &eacute;t&eacute; annul&eacute;es" : "avait &eacute;t&eacute; annul&eacute;e"} entre-temps.
  Les autres chambres sont confirm&eacute;es. <strong>Remboursement partiel &agrave; faire depuis la fiche du Dossier (bouton &laquo;&nbsp;Rembourser&nbsp;&raquo;)</strong>
  (paiement <code>${escapeHtml(stripePaymentId)}</code>).
</p>
${renderBookingSummaryTable(data)}`
    : `
<h2 style="margin: 0 0 16px 0; font-size: 22px; font-weight: 600; color: #b42318;">Paiement re&ccedil;u sur une r&eacute;servation annul&eacute;e</h2>
<p style="margin: 0 0 16px 0; font-size: 15px; line-height: 1.6;">
  ${escapeHtml(guestName)} (${escapeHtml(guestEmail)}) a pay&eacute; une r&eacute;servation qui avait &eacute;t&eacute; annul&eacute;e entre-temps.
  La r&eacute;servation reste annul&eacute;e : <strong>remboursez le client depuis la fiche du Dossier (bouton &laquo;&nbsp;Rembourser&nbsp;&raquo;)</strong>
  (paiement <code>${escapeHtml(stripePaymentId)}</code>), ou recr&eacute;ez la r&eacute;servation si la chambre est encore libre.
</p>
${renderBookingSummaryTable(data)}`;

  await sendEmail({
    tenantId: data.tenantId ?? null,
    to: adminEmail,
    subject: partial
      ? `Paiement reçu, une chambre annulée — remboursement partiel à faire via Stripe (${guestName})`
      : `Paiement reçu sur une réservation annulée — remboursez via Stripe (${guestName})`,
    html: renderEmailLayout({ hotelName, config }, body),
    hotelName: `DirectLoc`,
  });
}

// ─── 2c. Réseau des Voisins (ADR-0013) ──────────────────────────────────────

/** Contact de l'autre hôte d'un groupe partagé : faits publics de l'établissement. */
export type NetworkPartner = { name: string; phone: string | null };

type NetworkNoticeData = {
  adminEmail: string;
  /** Tenant destinataire (son nom et sa config habillent l'email). */
  tenantId: string;
  hotelName: string;
  config?: TenantConfig;
  /**
   * receiver : le Voisin qui a obtenu la réservation ; sender : l'hôte qui a orienté le voyageur ;
   * partner : groupe partagé, les deux Dossiers viennent d'être confirmés (échange des contacts).
   */
  role: "receiver" | "sender" | "partner";
  /** L'autre établissement (nom saisi par son hôte : toujours échappé). */
  otherName: string;
  checkIn: Date;
  checkOut: Date;
  /** Groupe partagé entre les deux établissements. */
  shared: boolean;
  /** Nom + téléphone de l'autre hôte (groupe partagé, les deux Dossiers confirmés). */
  partner?: NetworkPartner | null;
};

/**
 * Notification du réseau à un hôte. Jamais de donnée voyageur : l'envoyeur n'apprend que les dates
 * et le Voisin ; le Voisin a déjà le Dossier dans son admin.
 */
export async function sendNetworkNotice(d: NetworkNoticeData) {
  const other = escapeHtml(d.otherName);
  const stay = `du ${formatDate(d.checkIn)} au ${formatDate(d.checkOut)}`;
  const p = (html: string) => `<p style="margin: 0 0 16px 0; font-size: 15px; line-height: 1.6;">${html}</p>`;
  const partner = d.partner
    ? `<table style="width: 100%; border-collapse: collapse; margin-top: 8px;" data-network-partner>
  <tr><td style="padding: 8px 0; font-size: 15px; color: #666;">Groupe partag&eacute; avec</td><td style="padding: 8px 0; font-size: 15px; text-align: right; font-weight: 600;">${escapeHtml(d.partner.name)}</td></tr>
  <tr><td style="padding: 8px 0; font-size: 15px; color: #666;">T&eacute;l&eacute;phone</td><td style="padding: 8px 0; font-size: 15px; text-align: right;">${d.partner.phone ? escapeHtml(d.partner.phone) : "non renseign&eacute;"}</td></tr>
</table>
${p("Les deux r&eacute;servations sont confirm&eacute;es : vous pouvez vous coordonner pour l&rsquo;accueil du groupe.")}`
    : "";

  let subject: string;
  let body: string;
  if (d.role === "receiver") {
    subject = `Réservation obtenue grâce à ${d.otherName} (réseau DirectLoc)`;
    body = `
<h2 style="margin: 0 0 16px 0; font-size: 22px; font-weight: 600; color: #1a1a1a;">R&eacute;servation obtenue gr&acirc;ce &agrave; ${other} (r&eacute;seau DirectLoc)</h2>
${p(`${d.shared ? "Une partie d&rsquo;un groupe" : "Un voyageur"} orient&eacute;${d.shared ? "e" : ""} par <strong>${other}</strong> a r&eacute;serv&eacute; chez vous ${stay}. Le Dossier est dans votre espace DirectLoc.`)}
${partner}`;
  } else if (d.role === "sender") {
    subject = `Réseau DirectLoc : le voyageur orienté vers ${d.otherName} y a réservé`;
    body = `
<h2 style="margin: 0 0 16px 0; font-size: 22px; font-weight: 600; color: #1a1a1a;">Votre voyageur a r&eacute;serv&eacute; chez ${other}</h2>
${p(
  d.shared
    ? `Votre &eacute;tablissement ne pouvait pas loger tout le groupe ${stay} : la partie du groupe que vous avez orient&eacute;e vers <strong>${other}</strong> y a r&eacute;serv&eacute;.`
    : `Votre &eacute;tablissement &eacute;tait complet ${stay} : le voyageur que vous avez orient&eacute; vers <strong>${other}</strong> y a r&eacute;serv&eacute;.`,
)}
${p("Le r&eacute;seau DirectLoc garde vos voyageurs chez des h&ocirc;tes ind&eacute;pendants plut&ocirc;t que sur les plateformes.")}
${partner}`;
  } else {
    subject = `Groupe partagé avec ${d.otherName} : les deux réservations sont confirmées`;
    body = `
<h2 style="margin: 0 0 16px 0; font-size: 22px; font-weight: 600; color: #1a1a1a;">Groupe partag&eacute; avec ${other}</h2>
${p(`Le groupe ${stay} est r&eacute;parti entre votre &eacute;tablissement et <strong>${other}</strong> (r&eacute;seau DirectLoc).`)}
${partner}`;
  }

  await sendEmail({
    tenantId: d.tenantId,
    to: d.adminEmail,
    subject,
    html: renderEmailLayout({ hotelName: d.hotelName, config: d.config }, body),
    hotelName: "DirectLoc",
  });
}

/** Bilan mensuel du réseau : les seuls chiffres du tenant, jamais de total du réseau ni de donnée voyageur. */
export async function sendNetworkMonthlyReport(d: {
  adminEmail: string;
  tenantId: string;
  hotelName: string;
  config?: TenantConfig;
  /** Libellé du mois, ex. « octobre 2026 ». */
  monthLabel: string;
  sent: number;
  received: number;
  bookings: number;
}) {
  const li = (n: number, one: string, many: string) => `<li style="margin: 0 0 6px 0;"><strong>${n}</strong> ${n > 1 ? many : one}</li>`;
  const body = `
<h2 style="margin: 0 0 16px 0; font-size: 22px; font-weight: 600; color: #1a1a1a;">Bilan du r&eacute;seau DirectLoc &mdash; ${escapeHtml(d.monthLabel)}</h2>
<p style="margin: 0 0 16px 0; font-size: 15px; line-height: 1.6;">Voici l&rsquo;activit&eacute; de <strong>${escapeHtml(d.hotelName)}</strong> dans le r&eacute;seau des voisins le mois dernier.</p>
<ul data-network-report style="margin: 0 0 16px 0; padding-left: 20px; font-size: 15px; line-height: 1.6;">
${li(d.sent, "voyageur orient&eacute; vers un voisin", "voyageurs orient&eacute;s vers un voisin")}
${li(d.received, "voyageur re&ccedil;u d&rsquo;un voisin", "voyageurs re&ccedil;us de voisins")}
${li(d.bookings, "r&eacute;servation confirm&eacute;e gr&acirc;ce au r&eacute;seau", "r&eacute;servations confirm&eacute;es gr&acirc;ce au r&eacute;seau")}
</ul>`;
  await sendEmail({
    tenantId: d.tenantId,
    to: d.adminEmail,
    subject: `Réseau DirectLoc : votre bilan de ${d.monthLabel}`,
    html: renderEmailLayout({ hotelName: d.hotelName, config: d.config }, body),
    hotelName: "DirectLoc",
  });
}

// ─── 3. Annulation de réservation (client) ──────────────────────────────────

type CancellationEmailData = {
  guestName: string;
  guestEmail: string;
  /** Chambres annulées (une seule pour une réservation simple). */
  roomNames: string[];
  checkIn: Date;
  checkOut: Date;
  hotelName: string;
  config?: TenantConfig;
  reason: "admin" | "payment_expired";
  tenantId: string;
};

export async function sendBookingCancellation(data: CancellationEmailData) {
  const { guestName, guestEmail, roomNames, checkIn, checkOut, hotelName, config, reason } = data;

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
    <td style="padding: 10px 0; border-bottom: 1px solid #e5e5e5; color: #666; font-size: 15px;">Chambre${roomNames.length > 1 ? "s" : ""}</td>
    <td style="padding: 10px 0; border-bottom: 1px solid #e5e5e5; text-align: right; font-size: 15px;">${roomNames.map(escapeHtml).join("<br>")}</td>
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

// ─── 3b. Annulation partielle : une ou plusieurs chambres, le reste est maintenu ─

type PartialCancellationData = {
  guestName: string;
  guestEmail: string;
  checkIn: Date;
  checkOut: Date;
  hotelName: string;
  config?: TenantConfig;
  tenantId: string;
  cancelledRooms: { name: string; total: string }[];
  keptRooms: { name: string; total: string }[];
  /** Somme des chambres maintenues. */
  newTotal: string;
};

export async function sendPartialCancellation(data: PartialCancellationData) {
  const { guestName, guestEmail, checkIn, checkOut, hotelName, config, cancelledRooms, keptRooms, newTotal } = data;
  const cell = "padding: 8px 0; font-size: 15px;";
  const list = (rooms: { name: string; total: string }[]) =>
    rooms
      .map(
        (r) => `<tr><td style="${cell}">${escapeHtml(r.name)}</td><td style="${cell} text-align: right;">${escapeHtml(r.total)} &euro;</td></tr>`,
      )
      .join("");
  const many = cancelledRooms.length > 1;

  const body = `
<h2 style="margin: 0 0 16px 0; font-size: 24px; font-weight: 600; color: #1a1a1a;">Une partie de votre r&eacute;servation est annul&eacute;e</h2>
<p style="font-size: 15px; color: #333; line-height: 1.6;">Bonjour ${escapeHtml(guestName)},</p>
<p style="font-size: 15px; color: #333; line-height: 1.6;"><strong>${escapeHtml(hotelName)}</strong> a annul&eacute; ${many ? "des chambres" : "une chambre"} de votre r&eacute;servation du ${formatDate(checkIn)} au ${formatDate(checkOut)}. Le reste de votre s&eacute;jour est maintenu.</p>
<p style="margin: 24px 0 4px 0; font-size: 13px; letter-spacing: 0.06em; text-transform: uppercase; color: #b42318;">${many ? "Chambres annul&eacute;es" : "Chambre annul&eacute;e"}</p>
<table style="width: 100%; border-collapse: collapse; border-bottom: 1px solid #e5e5e5;">${list(cancelledRooms)}</table>
<p style="margin: 24px 0 4px 0; font-size: 13px; letter-spacing: 0.06em; text-transform: uppercase; color: #666;">${keptRooms.length > 1 ? "Chambres maintenues" : "Chambre maintenue"}</p>
<table style="width: 100%; border-collapse: collapse; border-bottom: 1px solid #e5e5e5;">${list(keptRooms)}</table>
<table style="width: 100%; border-collapse: collapse; margin: 8px 0 24px 0;">
  <tr>
    <td style="padding: 10px 0; color: #666; font-weight: 600; font-size: 15px;">Nouveau total</td>
    <td style="padding: 10px 0; text-align: right; font-size: 20px; font-weight: 700;">${escapeHtml(newTotal)} &euro;</td>
  </tr>
</table>
<p style="font-size: 15px; color: #333; line-height: 1.6;">Si vous aviez d&eacute;j&agrave; pay&eacute; ${many ? "ces chambres" : "cette chambre"}, le remboursement est effectu&eacute; directement par l'&eacute;tablissement : n'h&eacute;sitez pas &agrave; le contacter pour toute question.</p>`;

  await sendEmail({
    tenantId: data.tenantId ?? null,
    to: guestEmail,
    subject: `Annulation partielle de votre réservation — ${hotelName}`,
    html: renderEmailLayout({ hotelName, config }, body),
    hotelName,
    replyTo: config?.email,
  });
}

// ─── 3c. Remboursement (un email par remboursement, jamais depuis la démo) ────

export async function sendRefundNotice(data: {
  tenantId: string;
  guestName: string;
  guestEmail: string;
  hotelName: string;
  config?: TenantConfig;
  checkIn: Date;
  checkOut: Date;
  /** En euros. */
  amount: number;
}) {
  const { guestName, guestEmail, hotelName, config, checkIn, checkOut, amount } = data;
  const body = `
<h2 style="margin: 0 0 16px 0; font-size: 24px; font-weight: 600; color: #1a1a1a;">Remboursement de ${euros(amount)} &euro;</h2>
<p style="font-size: 15px; color: #333; line-height: 1.6;">Bonjour ${escapeHtml(guestName)},</p>
<p style="font-size: 15px; color: #333; line-height: 1.6;"><strong>${escapeHtml(hotelName)}</strong> vous rembourse <strong>${euros(amount)} &euro;</strong> pour votre r&eacute;servation du ${formatDate(checkIn)} au ${formatDate(checkOut)}.</p>
<p style="font-size: 15px; color: #333; line-height: 1.6;">Le montant est rendu sur la carte utilis&eacute;e pour le paiement. Selon votre banque, il appara&icirc;t sur votre compte sous 5 &agrave; 10 jours ouvr&eacute;s.</p>
<p style="font-size: 15px; color: #333; line-height: 1.6;">Pour toute question, r&eacute;pondez simplement &agrave; cet email.</p>`;

  await sendEmail({
    tenantId: data.tenantId,
    to: guestEmail,
    subject: `Remboursement de ${euros(amount)} € pour votre réservation — ${hotelName}`,
    html: renderEmailLayout({ hotelName, config }, body),
    hotelName,
    replyTo: config?.email,
  });
}

/** Alerte admin : un remboursement a échoué chez Stripe (rien n'est parti), à refaire depuis la fiche du Dossier. */
export async function sendRefundFailedAlert(data: {
  tenantId: string;
  adminEmail: string;
  guestName: string;
  guestEmail: string;
  hotelName: string;
  config?: TenantConfig;
  checkIn: Date;
  checkOut: Date;
  /** En euros, au format « 12.50 ». */
  amount: string;
  reason: string | null;
}) {
  const { guestName, guestEmail, hotelName, config, checkIn, checkOut, adminEmail } = data;
  const amount = euros(parseFloat(data.amount));
  const body = `
<h2 style="margin: 0 0 16px 0; font-size: 22px; font-weight: 600; color: #b42318;">Remboursement de ${amount} &euro; &eacute;chou&eacute;</h2>
<p style="margin: 0 0 16px 0; font-size: 15px; line-height: 1.6;">
  Le remboursement de <strong>${amount} &euro;</strong> pour ${escapeHtml(guestName)} (${escapeHtml(guestEmail)}), s&eacute;jour du ${formatDate(checkIn)} au ${formatDate(checkOut)}, a &eacute;chou&eacute; chez Stripe${data.reason ? ` (motif : <code>${escapeHtml(data.reason)}</code>)` : ""}.
  <strong>Rien n'a &eacute;t&eacute; rembours&eacute;</strong> : refaites-le depuis la fiche du Dossier (bouton &laquo;&nbsp;Rembourser&nbsp;&raquo;) ou contactez le voyageur pour un autre moyen de remboursement.
</p>`;
  await sendEmail({
    tenantId: data.tenantId,
    to: adminEmail,
    subject: `Remboursement de ${amount} € échoué (${guestName})`,
    html: renderEmailLayout({ hotelName, config }, body),
    hotelName: `DirectLoc`,
  });
}

/**
 * Alerte admin : un voyageur conteste le paiement auprès de sa banque (litige). Une seule fois par
 * litige (réservée par `disputes.alerted_at`). Montant, motif en français, date limite de réponse.
 */
export async function sendDisputeAlert(data: {
  tenantId: string;
  adminEmail: string;
  guestName: string;
  guestEmail: string;
  hotelName: string;
  config?: TenantConfig;
  checkIn: Date;
  checkOut: Date;
  /** En euros, au format « 12.50 ». */
  amount: string;
  /** Motif déjà traduit. */
  reason: string;
  dueBy: Date | null;
  dossierId: string;
}) {
  const { guestName, guestEmail, hotelName, config, checkIn, checkOut, adminEmail } = data;
  const amount = euros(parseFloat(data.amount));
  const due = data.dueBy
    ? data.dueBy.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Paris" })
    : null;
  const body = `
<h2 style="margin: 0 0 16px 0; font-size: 22px; font-weight: 600; color: #b42318;">Litige : ${amount} &euro; contest&eacute;s par ${escapeHtml(guestName)}</h2>
<p style="margin: 0 0 16px 0; font-size: 15px; line-height: 1.6;">
  ${escapeHtml(guestName)} (${escapeHtml(guestEmail)}) conteste aupr&egrave;s de sa banque le paiement de <strong>${amount} &euro;</strong> pour le s&eacute;jour du ${formatDate(checkIn)} au ${formatDate(checkOut)}.
  Motif donn&eacute; par la banque : <strong>${escapeHtml(data.reason)}</strong>.
</p>
<p style="margin: 0 0 16px 0; font-size: 15px; line-height: 1.6;">
  ${due ? `<strong>R&eacute;pondez avant le ${escapeHtml(due)}</strong>` : "<strong>R&eacute;pondez au plus vite</strong>"} : ouvrez la fiche du Dossier de ${escapeHtml(guestName)} dans DirectLoc, puis &laquo;&nbsp;R&eacute;pondre&nbsp;&raquo; (preuves pr&eacute;remplies) ou &laquo;&nbsp;Accepter&nbsp;&raquo;.
  Sans r&eacute;ponse &agrave; temps, la banque donne raison au voyageur et l'argent est repris.
</p>`;
  await sendEmail({
    tenantId: data.tenantId,
    to: adminEmail,
    subject: `Litige : ${amount} € contestés par ${guestName}${due ? ` — réponse avant le ${data.dueBy!.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", timeZone: "Europe/Paris" })}` : ""}`,
    html: renderEmailLayout({ hotelName, config }, body),
    hotelName: `DirectLoc`,
  });
}

// ─── 4. Rappel avant l'arrivée (J-2 par défaut, réglable par l'hôte) ─────────

/** « demain », « dans 7 jours ». */
const inDays = (n: number) => (n <= 1 ? "demain" : `dans ${n} jours`);

/** Séjour sans prix (rappel, remerciement) : une chambre = tableau historique ; plusieurs = une ligne par chambre. */
function renderStayTable(d: DossierEmailData): string {
  const cell = "padding: 10px 0; border-bottom: 1px solid #e5e5e5; font-size: 15px;";
  const rooms =
    d.rooms.length === 1
      ? `<tr><td style="${cell} color: #666;">Chambre</td><td style="${cell} text-align: right; font-weight: 600;">${escapeHtml(d.rooms[0].roomName)}</td></tr>`
      : d.rooms
          .map(
            (r, i) =>
              `<tr><td style="${cell} color: #666;">${i === 0 ? "Chambres" : ""}</td><td style="${cell} text-align: right; font-weight: 600;">${escapeHtml(r.roomName)}${persons(r.guestCount)}</td></tr>`,
          )
          .join("");
  return `
<table style="width: 100%; border-collapse: collapse; margin: 24px 0;">
  ${rooms}
  <tr>
    <td style="${cell} color: #666;">Arriv&eacute;e</td>
    <td style="${cell} text-align: right;">${formatDate(d.checkIn)}</td>
  </tr>
  <tr>
    <td style="${cell} color: #666;">D&eacute;part</td>
    <td style="${cell} text-align: right;">${formatDate(d.checkOut)}</td>
  </tr>
  <tr>
    <td style="padding: 10px 0; color: #666; font-size: 15px;">Dur&eacute;e</td>
    <td style="padding: 10px 0; text-align: right; font-size: 15px;">${d.nights} nuit${d.nights > 1 ? "s" : ""}</td>
  </tr>
</table>`;
}

export async function sendCheckInReminder(data: DossierEmailData & { daysUntil: number }) {
  const { guestName, guestEmail, hotelName, config, daysUntil } = data;

  const addressBlock = config?.address
    ? `<p style="font-size: 15px; color: #333; line-height: 1.6;"><strong>Adresse :</strong> ${escapeHtml(config.address)}</p>`
    : "";

  const body = `
<h2 style="margin: 0 0 16px 0; font-size: 24px; font-weight: 600; color: #1a1a1a;">Votre s&eacute;jour approche !</h2>
<p style="font-size: 15px; color: #333; line-height: 1.6;">Bonjour ${escapeHtml(guestName)},</p>
<p style="font-size: 15px; color: #333; line-height: 1.6;">Nous vous rappelons votre r&eacute;servation &agrave; <strong>${escapeHtml(hotelName)}</strong> ${inDays(daysUntil)}.</p>
${renderStayTable(data)}
${renderCustomMessage(config?.reminderMessage, generalContext(data))}
${renderRoomMessages(data)}
${addressBlock}
<p style="font-size: 15px; color: #333; line-height: 1.6;">&Agrave; tr&egrave;s bient&ocirc;t !</p>`;

  const html = renderEmailLayout({ hotelName, config }, body);

  await sendEmail({
    tenantId: data.tenantId ?? null,
    to: guestEmail,
    subject: `Rappel : votre séjour ${inDays(daysUntil)} — ${hotelName}`,
    html,
    hotelName,
    replyTo: config?.email,
  });
}

// ─── 5. Remerciement post-séjour ────────────────────────────────────────────

export async function sendPostStayThankYou(data: DossierEmailData) {
  const { guestName, guestEmail, hotelName, config } = data;

  const customMessage = renderCustomMessage(config?.postStayMessage, generalContext(data));

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
${data.rooms.length > 1 ? `<p style="font-size: 15px; color: #333; line-height: 1.6;">Chambres : ${data.rooms.map((r) => escapeHtml(r.roomName)).join(", ")}.</p>` : ""}
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

export async function sendCallbackRequest(data: { name: string; phone: string; place: string; ref?: string }) {
  const to = process.env.OPERATOR_EMAIL ?? fromAddress;
  const html = `<p>Demande de rappel depuis directloc.app :</p>
<ul>
  <li>Nom : <strong>${escapeHtml(data.name)}</strong></li>
  <li>Téléphone : <strong>${escapeHtml(data.phone)}</strong></li>
  ${data.place ? `<li>Hébergement / commune : ${escapeHtml(data.place)}</li>` : ""}
  ${data.ref ? `<li>Partenaire (ref) : <strong>${escapeHtml(data.ref)}</strong></li>` : ""}
</ul>`;
  await sendEmail({ to, subject: `Rappel demandé — ${data.name}`, html, hotelName: "DirectLoc", tenantId: null });
}
