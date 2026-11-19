import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSession } from "@/lib/session";
import { getRoomsByTenant } from "@/lib/queries/rooms";
import { loadEditableBooking } from "@/lib/queries/bookings";
import { grandTotal } from "@/lib/extras";
import ManualBookingForm from "@/components/admin/ManualBookingForm";
import { bedLimit } from "@/lib/extras";
import { getBookingLines, getExtrasByTenant } from "@/lib/queries/extras";
import { getFeesByTenant, getTouristTax } from "@/lib/queries/fees";

export const metadata = { title: "Modifier la réservation" };

export default async function EditReservationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { tenantId } = await requireSession();
  const [editable, chambres, catalog, feeCatalog, touristTax] = await Promise.all([
    loadEditableBooking(id, tenantId),
    getRoomsByTenant(tenantId),
    getExtrasByTenant(tenantId, { activeOnly: true }),
    getFeesByTenant(tenantId, { activeOnly: true }),
    getTouristTax(tenantId),
  ]);
  // Terminée, annulée, en plein paiement en ligne ou d'un autre tenant : rien à modifier ici.
  if (!editable) notFound();
  const { booking, payment } = editable;
  const lines = await getBookingLines(id);
  const iso = (d: Date) => new Date(d).toISOString().slice(0, 10);

  return (
    <div className="space-y-6 max-w-xl admin-fade-in">
      <Link
        href={`/admin/reservations/${id}`}
        className="inline-block text-[13px] font-semibold transition-colors"
        style={{ color: "var(--admin-text-muted)" }}
      >
        ← {booking.guestName}
      </Link>

      <h1
        className="text-[24px] font-extrabold leading-tight"
        style={{ color: "var(--admin-text)", letterSpacing: "-0.6px" }}
      >
        Modifier la réservation
      </h1>

      <ManualBookingForm
        rooms={chambres
          .filter((c) => c.active)
          .map((c) => ({ id: c.id, name: c.name, pricePerNight: String(c.pricePerNight), maxBeds: bedLimit(c) }))}
        extras={catalog}
        fees={feeCatalog}
        taxEnabled={!!touristTax}
        today={iso(booking.checkIn)}
        tomorrow={iso(booking.checkOut)}
        edit={{
          id,
          values: {
            roomId: booking.roomId,
            checkIn: iso(booking.checkIn),
            checkOut: iso(booking.checkOut),
            guestName: booking.guestName,
            guestEmail: booking.guestEmail,
            guestPhone: booking.guestPhone ?? "",
            guestCount: String(booking.guestCount),
            childCount: String(booking.childCount),
            notes: booking.notes ?? "",
          },
          oldTotal: parseFloat(booking.totalPrice),
          oldAccommodation: grandTotal(parseFloat(booking.totalPrice), lines.map((l) => ({ total: -l.total }))),
          lines: lines.filter((l) => l.kind === "extra"),
          feeLines: lines.filter((l) => l.kind === "fee"),
          taxExempt: lines.some((l) => l.kind === "tax" && l.exempt),
          paidOnline: payment?.status === "paid" ? parseFloat(payment.amount) : null,
        }}
      />
    </div>
  );
}
