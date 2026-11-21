import { countryName } from "@/lib/countries";
import { eq, inArray } from "drizzle-orm";
import { PDFDocument, rgb, StandardFonts, type PDFPage } from "pdf-lib";
import { db } from "@/lib/db";
import { bookings, rooms, tenants } from "@/db/schema";
import { getBookingLines } from "@/lib/queries/extras";
import { grandTotal } from "@/lib/extras";

const STATUS_LABELS: Record<string, string> = {
  pending: "En attente",
  confirmed: "Confirmée",
  cancelled: "Annulée",
  completed: "Terminée",
};

type Booking = typeof bookings.$inferSelect;

/**
 * PDF de confirmation : une réservation, ou un Dossier entier (ADR-0012 : mêmes dates,
 * même voyageur, une section par chambre puis le total). Les réservations sont déjà
 * filtrées sur le tenant par l'appelant. Retourne les octets et un nom de fichier.
 */
export async function renderReservationPdf(
  tenantId: string,
  list: Booking[],
  opts: { ref: string; filePrefix: string },
): Promise<{ bytes: Uint8Array; filename: string }> {
  const first = list[0];
  const roomNames = new Map(
    (
      await db
        .select({ id: rooms.id, name: rooms.name })
        .from(rooms)
        .where(inArray(rooms.id, [...new Set(list.map((b) => b.roomId))]))
    ).map((r) => [r.id, r.name]),
  );
  const [tenant] = await db
    .select({ name: tenants.name, config: tenants.config })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  const config = (tenant?.config ?? {}) as Record<string, string>;
  const multi = list.length > 1;

  const pdfDoc = await PDFDocument.create();
  const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const dark = rgb(0.1, 0.1, 0.1);
  const medium = rgb(0.35, 0.35, 0.35);
  const light = rgb(0.6, 0.6, 0.6);
  const accent = rgb(0.76, 0.55, 0.2);
  const lineColor = rgb(0.85, 0.83, 0.8);

  const margin = 50;
  const pageWidth = 595 - margin * 2;
  let page: PDFPage = pdfDoc.addPage([595, 842]); // A4
  let y = 792;

  /** Nouvelle page quand la place manque (un Dossier de plusieurs chambres déborde). */
  function ensure(space: number) {
    if (y - space >= 70) return;
    page = pdfDoc.addPage([595, 842]);
    y = 792;
  }

  // Helvetica standard = WinAnsi : un caractère hors jeu (emoji, idéogramme) ferait échouer tout le PDF.
  const printable = (text: string) =>
    [...text]
      .filter((c) => {
        if (c === "\n") return true; // drawText découpe les lignes lui-même
        try {
          helvetica.encodeText(c);
          return true;
        } catch {
          return false;
        }
      })
      .join("");

  // ── Header: Hotel name ──
  page.drawText(printable(tenant?.name ?? "DirectLoc"), { x: margin, y, size: 22, font: helveticaBold, color: dark });
  y -= 20;

  const contactParts: string[] = [];
  if (config.address) contactParts.push(config.address);
  if (config.phone) contactParts.push(config.phone);
  if (config.email) contactParts.push(config.email);
  if (contactParts.length > 0) {
    page.drawText(printable(contactParts.join("  ·  ")), { x: margin, y, size: 9, font: helvetica, color: light });
    y -= 14;
  }

  y -= 10;
  page.drawLine({ start: { x: margin, y }, end: { x: margin + pageWidth, y }, thickness: 1, color: lineColor });
  y -= 30;

  // ── Title ──
  page.drawText("Confirmation de réservation", { x: margin, y, size: 16, font: helveticaBold, color: dark });
  y -= 22;

  // Statut : celui de la réservation ; pour un Dossier, le détail est par chambre.
  const statusText = multi
    ? `${list.length} chambres`
    : `Statut : ${STATUS_LABELS[first.status] ?? first.status}`;
  page.drawText(statusText, {
    x: margin,
    y,
    size: 10,
    font: helvetica,
    color: !multi && first.status === "confirmed" ? rgb(0.1, 0.55, 0.2) : medium,
  });
  y -= 10;

  page.drawText(`Réf. : ${opts.ref}`, { x: margin + pageWidth - 120, y: y + 10, size: 9, font: helvetica, color: light });
  y -= 20;

  function drawSection(title: string) {
    ensure(60);
    y -= 8;
    page.drawLine({ start: { x: margin, y: y + 4 }, end: { x: margin + pageWidth, y: y + 4 }, thickness: 0.5, color: lineColor });
    y -= 16;
    page.drawText(printable(title.toUpperCase()), { x: margin, y, size: 8, font: helveticaBold, color: accent });
    y -= 18;
  }

  function drawRow(rawLabel: string, rawValue: string) {
    ensure(18);
    page.drawText(printable(rawLabel), { x: margin, y, size: 10, font: helvetica, color: medium });
    page.drawText(printable(rawValue), { x: margin + 160, y, size: 10, font: helveticaBold, color: dark });
    y -= 18;
  }

  function drawTotal(label: string, amount: number) {
    ensure(36);
    y -= 4;
    page.drawLine({ start: { x: margin + 160, y: y + 2 }, end: { x: margin + pageWidth, y: y + 2 }, thickness: 0.5, color: lineColor });
    y -= 14;
    page.drawText(label, { x: margin, y, size: 12, font: helveticaBold, color: dark });
    page.drawText(`${amount.toFixed(2)} €`, { x: margin + 160, y, size: 12, font: helveticaBold, color: dark });
    y -= 18;
  }

  const checkIn = new Date(first.checkIn);
  const checkOut = new Date(first.checkOut);
  const nights = Math.ceil((checkOut.getTime() - checkIn.getTime()) / (1000 * 60 * 60 * 24));
  const formatDate = (d: Date) =>
    d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  const people = (n: number) => `${n} personne${n > 1 ? "s" : ""}`;

  // ── Séjour ──
  drawSection("Séjour");
  if (!multi) drawRow("Chambre", roomNames.get(first.roomId) ?? "—");
  drawRow("Arrivée", formatDate(checkIn));
  drawRow("Départ", formatDate(checkOut));
  drawRow("Durée", `${nights} nuit${nights > 1 ? "s" : ""}`);
  drawRow("Voyageurs", people(list.reduce((n, b) => n + b.guestCount, 0)));

  // ── Client ──
  drawSection("Client");
  drawRow("Nom", first.guestName);
  drawRow("Email", first.guestEmail);
  if (first.guestPhone) drawRow("Téléphone", first.guestPhone);
  // Une ligne, sans retour : une adresse très longue est coupée (complète dans l'admin).
  if (first.guestAddress) {
    const a = first.guestAddress.replace(/\s+/g, " ");
    drawRow("Adresse", a.length > 64 ? `${a.slice(0, 61)}...` : a);
  }
  if (first.guestCountry) drawRow("Pays", countryName(first.guestCountry));

  // ── Paiement, par chambre ──
  for (const booking of list) {
    const name = roomNames.get(booking.roomId) ?? "Chambre";
    drawSection(multi ? `${name} · ${STATUS_LABELS[booking.status] ?? booking.status}` : "Paiement");
    if (multi) drawRow("Voyageurs", people(booking.guestCount));
    // Prix / nuit sur l'hébergement seul : les Extras sont listés à part.
    const extraLines = await getBookingLines(booking.id);
    const accommodation = grandTotal(parseFloat(booking.totalPrice), extraLines.map((l) => ({ total: -l.total })));
    const pricePerNight = nights > 0 ? (accommodation / nights).toFixed(2) : accommodation.toFixed(2);
    drawRow("Prix / nuit", `${pricePerNight} €`);
    drawRow("Nombre de nuits", String(nights));
    if (extraLines.length > 0) drawRow("Hébergement", `${accommodation.toFixed(2)} €`);
    for (const l of extraLines) {
      const label = l.kind !== "tax" && l.quantity > 1 ? `${l.label} (${l.quantity} × ${l.unitPrice.toFixed(2)} €)` : l.label;
      // Libellé jusqu'à 500 caractères : tronqué pour tenir dans la colonne.
      drawRow(label.length > 28 ? label.slice(0, 27) + "…" : label, l.exempt ? "Exonérée" : l.total === 0 ? "Offert" : `${l.total.toFixed(2)} €`);
    }
    drawTotal(multi ? "Total chambre" : "Total", parseFloat(booking.totalPrice));
    if (!multi) drawRow("Source", booking.source === "manual" ? "Saisie manuelle" : "Site direct");
  }

  if (multi) {
    // Une chambre annulée ne compte pas dans ce que le séjour coûte.
    drawSection("Total du séjour");
    const active = list.filter((b) => b.status !== "cancelled");
    drawTotal("Total", grandTotal(0, active.map((b) => ({ total: parseFloat(b.totalPrice) }))));
    drawRow("Source", first.source === "manual" ? "Saisie manuelle" : "Site direct");
  }

  // ── Notes ──
  const notes = [...new Set(list.map((b) => b.notes).filter((n): n is string => !!n))];
  if (notes.length > 0) {
    drawSection("Notes");
    for (const n of notes) {
      ensure(30);
      page.drawText(printable(n), { x: margin, y, size: 10, font: helvetica, color: medium, maxWidth: pageWidth });
      y -= 18;
    }
  }

  // ── Footer ──
  page.drawText(
    `Généré le ${new Date().toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" })}`,
    { x: margin, y: 50, size: 8, font: helvetica, color: light },
  );

  const bytes = await pdfDoc.save();
  const safeName = first.guestName
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .toLowerCase()
    .slice(0, 50);
  return { bytes, filename: `${opts.filePrefix}-${safeName || "guest"}.pdf` };
}

export function pdfResponse({ bytes, filename }: { bytes: Uint8Array; filename: string }) {
  return new Response(Buffer.from(bytes), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${filename}"`,
    },
  });
}
