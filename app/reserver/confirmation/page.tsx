import type { Metadata } from "next";
import type { ComponentProps } from "react";
import { tenantIcons } from "@/lib/seo";
import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { and, eq, inArray } from "drizzle-orm";
import PublicLayout from "@/components/public/PublicLayout";
import Confirmation from "@/components/public/Confirmation";
import { requireTenant } from "@/lib/tenant-context";
import { db } from "@/lib/db";
import { bookings, payments, rooms } from "@/db/schema";
import { getDossierBookingIds } from "@/lib/dossiers";
import type { TenantConfig } from "@/lib/tenant-context";
import { parseShare } from "@/lib/network-geo";
import { recheckShare } from "@/lib/network";
import { getBookingLines } from "@/lib/queries/extras";

// Tunnel de réservation : rien à indexer.
export async function generateMetadata(): Promise<Metadata> {
  const icons = tenantIcons(((await requireTenant()).config ?? {}) as TenantConfig);
  return { robots: { index: false, follow: false }, ...(icons ? { icons } : {}) };
}

export default async function ConfirmationPage({
  searchParams,
}: {
  searchParams: Promise<{ session_id?: string; share?: string }>;
}) {
  const { session_id, share } = await searchParams;

  const headersList = await headers();
  const tenantId = headersList.get("x-tenant-id");

  if (!tenantId) {
    notFound();
  }

  const tenant = await requireTenant();
  const config = (tenant.config ?? {}) as TenantConfig;

  if (!session_id) notFound();
  const [payment] = await db
    .select({ dossierId: payments.dossierId })
    .from(payments)
    .where(and(eq(payments.stripeSessionId, session_id), eq(payments.tenantId, tenantId)))
    .limit(1);
  if (!payment) notFound();

  // Toutes les chambres de la réservation (Dossier, ADR-0012).
  const ids = await getDossierBookingIds(payment.dossierId, tenantId);
  const rows = ids.length
    ? await db
        .select({ booking: bookings, roomName: rooms.name })
        .from(bookings)
        .leftJoin(rooms, eq(rooms.id, bookings.roomId))
        .where(and(inArray(bookings.id, ids), eq(bookings.tenantId, tenantId)))
    : [];
  // Chambres créées dans la même transaction (même createdAt) : ordre stable par nom de chambre.
  const stays = ids
    .flatMap((id) => rows.filter((r) => r.booking.id === id))
    .sort((a, b) => (ids.length > 1 ? (a.roomName ?? "").localeCompare(b.roomName ?? "", "fr") : 0));
  if (stays.length === 0) notFound();
  // 1re réservation créée : référence (inchangée pour une chambre), dates et voyageur communs.
  const booking = (stays.find((r) => r.booking.id === ids[0]) ?? stays[0]).booking;

  const roomsBooked = await Promise.all(
    stays.map(async ({ booking: b, roomName }) => ({
      name: roomName ?? null,
      guests: b.guestCount,
      total: b.totalPrice,
      extras: await getBookingLines(b.id),
    })),
  );

  const checkIn = new Date(booking.checkIn);
  const checkOut = new Date(booking.checkOut);

  const nights = Math.round(
    (checkOut.getTime() - checkIn.getTime()) / (1000 * 60 * 60 * 24),
  );

  // Payé = le webhook a confirmé les chambres (toutes en même temps).
  const isPaid = stays.some((r) => r.booking.status === "confirmed");
  const totalPrice = (
    stays.reduce((sum, r) => sum + Math.round(parseFloat(r.booking.totalPrice) * 100), 0) / 100
  ).toFixed(2);

  // Référence courte basée sur l'id de la 1re réservation (6 derniers caractères hex)
  const reference = `${tenant.slug.slice(0, 2).toUpperCase()}-${booking.id.slice(-6).toUpperCase()}`;

  // Partage de groupe : le reste du groupe, revérifié en direct (jamais cru sur parole : l'URL ne
  // donne que le nombre de personnes et le Voisin préféré, les dates viennent de la réservation).
  const sharePart = parseShare(share);
  let shareFollowUp: ComponentProps<typeof Confirmation>["share"];
  if (sharePart) {
    const { voisin, other } = await recheckShare(
      { originTenantId: tenantId, checkIn, checkOut, adults: sharePart.adults, minors: sharePart.minors },
      sharePart.slug,
    );
    const day = (d: Date) => d.toISOString().slice(0, 10);
    shareFollowUp = {
      guests: sharePart.adults + sharePart.minors,
      other,
      voisin: voisin && {
        name: voisin.name,
        city: voisin.city,
        distanceKm: voisin.distanceKm,
        href: `/voisin/${voisin.slug}?${new URLSearchParams({
          checkIn: day(checkIn),
          checkOut: day(checkOut),
          adults: String(sharePart.adults),
          minors: String(sharePart.minors),
          kind: "shared",
          // Le Dossier de l'hôte : relu par /voisin (même domaine) pour relier les deux Dossiers
          // du groupe ; il ne quitte jamais ce site (absent de la redirection vers le Voisin).
          dossier: payment.dossierId,
        })}`,
      },
    };
  }

  return (
    <PublicLayout>
      <Confirmation
        isPaid={isPaid}
        guestName={booking.guestName}
        guestFirstName={booking.guestFirstName}
        guestEmail={booking.guestEmail}
        rooms={roomsBooked}
        checkIn={checkIn}
        checkOut={checkOut}
        nights={nights}
        totalPrice={totalPrice}
        reference={reference}
        config={config}
        share={shareFollowUp}
      />
    </PublicLayout>
  );
}
