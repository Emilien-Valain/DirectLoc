"use client";

import { useActionState, useEffect, useRef, useState, type ReactNode } from "react";
import { formatEuros } from "@/lib/utils";
import {
  addDossierRoom,
  quoteDossierDates,
  quoteManualBooking,
  updateDossierDates,
  type ManualBookingState,
} from "@/lib/actions/bookings";
import { AdminInput, AdminSelect, DateInput, Field, StatusBanner } from "@/components/admin/ui";
import { extraQuantitiesFrom, matchesRoom } from "@/lib/extras";
import type { CatalogExtra } from "@/lib/queries/extras";
import type { CatalogFee } from "@/lib/queries/fees";
import { calendarHrefFor, choices, ForcePanel, StayChoicesFields } from "@/components/admin/StayChoices";

/**
 * Fiche Dossier (ADR-0012) : changer les dates de toutes les chambres d'un coup, ajouter une
 * chambre. Même serveur et mêmes morceaux que la saisie manuelle (devis, options, « Forcer »).
 */

/** Panneau repliable de la fiche : fermé par défaut, la fiche reste une fiche de lecture. */
function Panel({ label, hint, testId, children }: { label: string; hint: string; testId: string; children: ReactNode }) {
  return (
    <details
      data-testid={testId}
      className="group rounded-[var(--admin-radius)]"
      style={{ background: "var(--admin-surface)", border: "1px dashed var(--admin-border)" }}
    >
      <summary
        className="cursor-pointer list-none [&::-webkit-details-marker]:hidden flex items-center justify-between gap-3 min-h-[48px] px-4 py-2.5"
        style={{ color: "var(--admin-text)" }}
      >
        <span className="min-w-0">
          <span className="block text-[14px] font-bold" style={{ color: "var(--admin-primary)" }}>
            {label}
          </span>
          <span className="block text-[12.5px] leading-snug" style={{ color: "var(--admin-text-muted)" }}>
            {hint}
          </span>
        </span>
        <span
          aria-hidden
          className="flex-shrink-0 w-7 h-7 grid place-items-center rounded-full text-[16px] font-bold transition-transform duration-200 group-open:rotate-45"
          style={{ background: "var(--admin-primary-light)", color: "var(--admin-primary)" }}
        >
          +
        </span>
      </summary>
      <div className="px-4 pb-4 pt-1">{children}</div>
    </details>
  );
}

function NotifyGuest({ state, email }: { state: ManualBookingState; email: string }) {
  return (
    <label className="flex items-start gap-2.5 pt-1 pb-2 cursor-pointer" style={{ color: "var(--admin-text)" }}>
      <input
        type="checkbox"
        name="notifyGuest"
        className="mt-0.5"
        style={{ accentColor: "var(--admin-primary)" }}
        defaultChecked={state ? state.values.notifyGuest === "on" : true}
      />
      <span className="text-[13px] leading-snug break-words min-w-0">
        Prévenir le client par email
        <span className="block text-[12px]" style={{ color: "var(--admin-text-muted)" }}>
          {email} reçoit le nouveau récapitulatif du séjour.
        </span>
      </span>
    </label>
  );
}

function Submit({ pending, children }: { pending: boolean; children: ReactNode }) {
  return (
    <button
      type="submit"
      disabled={pending}
      className="admin-btn w-full sm:w-auto min-h-[44px]"
      style={{ background: "var(--admin-primary)", color: "#fff", border: "none" }}
    >
      {pending ? "Enregistrement…" : children}
    </button>
  );
}

const isoToFr = (iso: string) => iso.split("-").reverse().join("/");

/** Nouvelles dates pour toutes les chambres non annulées ; devis par chambre avant d'enregistrer. */
export function DossierDatesForm({
  dossierId,
  checkIn,
  checkOut,
  rooms,
  guestEmail,
}: {
  dossierId: string;
  /** AAAA-MM-JJ. */
  checkIn: string;
  checkOut: string;
  rooms: { bookingId: string; name: string; total: number }[];
  guestEmail: string;
}) {
  const [state, action, pending] = useActionState<ManualBookingState, FormData>(
    updateDossierDates.bind(null, dossierId),
    null,
  );
  const v = state?.values ?? { checkIn: isoToFr(checkIn), checkOut: isoToFr(checkOut) };
  const fe = state?.fieldErrors ?? {};
  const formRef = useRef<HTMLFormElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [quote, setQuote] = useState<Awaited<ReturnType<typeof quoteDossierDates>>>(null);
  const refreshQuote = () => {
    clearTimeout(timer.current);
    // Différé : le sélecteur de date met à jour le champ texte après l'événement.
    timer.current = setTimeout(async () => {
      const f = formRef.current;
      if (!f) return;
      const fd = new FormData(f);
      setQuote(await quoteDossierDates(dossierId, String(fd.get("checkIn") ?? ""), String(fd.get("checkOut") ?? "")));
    }, 300);
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(refreshQuote, [state]);
  const oldTotal = rooms.reduce((n, r) => Math.round((n + r.total) * 100) / 100, 0);
  const newTotal = quote?.totals.reduce((n, r) => Math.round((n + r.total) * 100) / 100, 0);

  return (
    <Panel
      testId="dossier-dates"
      label="Changer les dates"
      hint={rooms.length > 1 ? `Les ${rooms.length} chambres bougent ensemble.` : "La chambre et le Dossier bougent ensemble."}
    >
      <form key={JSON.stringify(v)} ref={formRef} action={action} onChange={refreshQuote}>
        {state?.error && !state.conflict && (
          <div role="alert">
            <StatusBanner variant="error">{state.error}</StatusBanner>
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Arrivée *" error={fe.checkIn}>
            <DateInput name="checkIn" required defaultValue={v.checkIn} />
          </Field>
          <Field label="Départ *" error={fe.checkOut}>
            <DateInput name="checkOut" required defaultValue={v.checkOut} />
          </Field>
        </div>

        <div
          aria-live="polite"
          data-dates-quote
          className="mb-3 px-3.5 py-2.5 rounded-lg text-[13px] leading-[1.55]"
          style={{ background: "var(--admin-surface-2)", color: "var(--admin-text-muted)" }}
        >
          {quote ? (
            <>
              <ul className="space-y-0.5">
                {rooms.map((r) => {
                  const next = quote.totals.find((t) => t.bookingId === r.bookingId)?.total;
                  return (
                    <li key={r.bookingId} className="flex justify-between gap-3">
                      <span className="min-w-0 break-words">{r.name}</span>
                      <span className="tabular-nums whitespace-nowrap">
                        {next === undefined || next === r.total ? formatEuros(r.total) : `${formatEuros(r.total)} → ${formatEuros(next)}`}
                      </span>
                    </li>
                  );
                })}
              </ul>
              <p className="flex justify-between gap-3 mt-1.5 pt-1.5" style={{ borderTop: "1px solid var(--admin-border-light)" }}>
                <span>
                  {quote.nights} nuit{quote.nights > 1 ? "s" : ""}, options et taxe recalculées
                </span>
                <span className="tabular-nums whitespace-nowrap">
                  Total{" "}
                  <strong className="text-[15px]" style={{ color: "var(--admin-text)" }}>
                    {formatEuros(newTotal ?? oldTotal)}
                  </strong>
                </span>
              </p>
            </>
          ) : (
            <span>Saisissez une arrivée et un départ valides pour voir le nouveau prix.</span>
          )}
        </div>

        <NotifyGuest state={state} email={guestEmail} />
        {state?.conflict && <ForcePanel state={state} calendarHref={calendarHrefFor(v.checkIn)} />}
        <div className="pt-2">
          <Submit pending={pending}>{rooms.length > 1 ? `Déplacer les ${rooms.length} chambres` : "Déplacer le séjour"}</Submit>
        </div>
      </form>
    </Panel>
  );
}

export type AddableRoom = { id: string; name: string; pricePerNight: string; maxBeds: number; capacity: number; free: boolean };

/** Une chambre de plus, aux dates du Dossier, pour le même voyageur. */
export function DossierAddRoomForm({
  dossierId,
  checkIn,
  checkOut,
  rooms,
  extras,
  fees,
  taxEnabled,
  guestEmail,
}: {
  dossierId: string;
  /** AAAA-MM-JJ (dates du Dossier, non modifiables ici). */
  checkIn: string;
  checkOut: string;
  rooms: AddableRoom[];
  extras: CatalogExtra[];
  fees: CatalogFee[];
  taxEnabled: boolean;
  guestEmail: string;
}) {
  const [state, action, pending] = useActionState<ManualBookingState, FormData>(addDossierRoom.bind(null, dossierId), null);
  const v = state?.values ?? {};
  const fe = state?.fieldErrors ?? {};
  const formRef = useRef<HTMLFormElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [roomId, setRoomId] = useState(v.roomId ?? "");
  const [guests, setGuests] = useState(Math.max(1, Number(v.guestCount) || 1));
  const [chosenExtras, setChosenExtras] = useState<string[]>([]);
  const [chosenFees, setChosenFees] = useState<string[]>(() => fees.map((f) => f.id));
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [total, setTotal] = useState<number | null>(null);
  const room = rooms.find((r) => r.id === roomId);
  const nights = Math.round((Date.parse(checkOut) - Date.parse(checkIn)) / 86_400_000);

  const refreshQuote = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      const f = formRef.current;
      if (!f) return;
      const fd = new FormData(f);
      const val = (n: string) => String(fd.get(n) ?? "");
      setGuests(Math.max(1, Math.floor(Number(val("guestCount"))) || 1));
      if (!val("roomId")) return setTotal(null);
      const quote = await quoteManualBooking({
        roomId: val("roomId"),
        checkIn,
        checkOut,
        guestCount: val("guestCount"),
        childCount: val("childCount"),
        extraIds: fd.getAll("extraIds").map(String),
        extraQuantities: extraQuantitiesFrom(fd.entries()),
        feeIds: fd.getAll("feeIds").map(String),
        waiveTax: fd.get("waiveTax") === "on",
        agreedPrice: "",
        keepPrice: false,
      });
      setTotal(quote?.total ?? null);
    }, 300);
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(refreshQuote, [state, roomId]);

  if (rooms.length === 0) return null;
  return (
    <Panel testId="dossier-add-room" label="Ajouter une chambre" hint="Mêmes dates, même voyageur, même Dossier.">
      <form key={JSON.stringify(v)} ref={formRef} action={action} onChange={refreshQuote}>
        {state?.error && !state.conflict && (
          <div role="alert">
            <StatusBanner variant="error">{state.error}</StatusBanner>
          </div>
        )}
        <Field label="Chambre *" error={fe.roomId}>
          <AdminSelect name="roomId" required defaultValue={roomId} onChange={(e) => setRoomId(e.target.value)}>
            <option value="">Sélectionner…</option>
            {rooms.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name} — {r.capacity} pers.{r.free ? "" : " · occupée sur ces dates"}
              </option>
            ))}
          </AdminSelect>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Voyageurs *" error={fe.guestCount}>
            <AdminInput name="guestCount" type="number" min="1" required defaultValue={v.guestCount ?? 1} />
          </Field>
          {taxEnabled && (
            <Field label="Dont enfants" error={fe.childCount}>
              <AdminInput name="childCount" type="number" min="0" defaultValue={v.childCount ?? 0} />
            </Field>
          )}
        </div>
        {taxEnabled && (
          <label className="flex items-start gap-2.5 mb-3 cursor-pointer" style={{ color: "var(--admin-text)" }}>
            <input
              type="checkbox"
              name="waiveTax"
              className="mt-0.5"
              style={{ accentColor: "var(--admin-primary)" }}
              defaultChecked={v.waiveTax === "on"}
            />
            <span className="text-[13px] leading-snug">Exonérer de la taxe de séjour</span>
          </label>
        )}
        <StayChoicesFields
          feeChoices={choices([], fees.filter((f) => roomId && matchesRoom(f, roomId)))}
          extraChoices={choices([], extras.filter((x) => roomId && matchesRoom(x, roomId)))}
          fees={[chosenFees, setChosenFees]}
          extras={[chosenExtras, setChosenExtras]}
          counts={[counts, setCounts]}
          stay={{ nights: Math.max(1, nights), guests, beds: room?.maxBeds ?? 1 }}
        />
        <p
          aria-live="polite"
          data-add-room-quote
          className="mb-3 px-3.5 py-2.5 rounded-lg text-[13px] flex justify-between gap-3"
          style={{ background: "var(--admin-surface-2)", color: "var(--admin-text-muted)" }}
        >
          <span>
            {nights} nuit{nights > 1 ? "s" : ""}, options, frais et taxe compris
          </span>
          <strong className="text-[15px] tabular-nums" style={{ color: "var(--admin-text)" }}>
            {total === null ? "—" : `+ ${formatEuros(total)}`}
          </strong>
        </p>
        <NotifyGuest state={state} email={guestEmail} />
        {state?.conflict && <ForcePanel state={state} calendarHref={calendarHrefFor(checkIn)} />}
        <div className="pt-2">
          <Submit pending={pending}>Ajouter au Dossier</Submit>
        </div>
      </form>
    </Panel>
  );
}
