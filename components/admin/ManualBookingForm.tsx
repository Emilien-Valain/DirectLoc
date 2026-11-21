"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { formatEuros } from "@/lib/utils";
import {
  createBookingManual,
  quoteManualBooking,
  updateBookingManual,
  type ManualBookingState,
} from "@/lib/actions/bookings";
import {
  AdminInput,
  AdminSelect,
  AdminTextarea,
  DateInput,
  Field,
  StatusBanner,
} from "@/components/admin/ui";
import {
  EXTRA_UNIT_LABELS,
  extraQuantitiesFrom,
  matchesRoom,
  CHOSEN_WORDS,
  chosenLabel,
  chosenMax,
  resolveChosen,
  type ExtraUnit,
  type StayLine,
} from "@/lib/extras";
import type { CatalogExtra } from "@/lib/queries/extras";
import type { CatalogFee } from "@/lib/queries/fees";

type RoomOption = { id: string; name: string; pricePerNight: string; maxBeds?: number };

/** Modification d'un séjour existant : valeurs actuelles, ancien total, montant déjà payé en ligne. */
export type BookingEdit = {
  id: string;
  values: Record<string, string>;
  oldTotal: number;
  /** Ancien total moins toutes ses lignes : ce que « Garder l'ancien prix » conserve. */
  oldAccommodation: number;
  paidOnline: number | null;
  /** Lignes d'Extras déjà sur la réservation (prix figé, même si l'option a été désactivée). */
  lines: FrozenLine[];
  /** Lignes de Fees déjà sur la réservation (prix figé). */
  feeLines: FrozenLine[];
  /** La taxe de séjour a été exonérée par l'hôte. */
  taxExempt: boolean;
  /** Chambres du Dossier (ADR-0012) : à partir de 2, dates communes et voyageur partagé. */
  dossierRooms?: number;
};

/** Chambre supplémentaire d'un Dossier saisi à la main (création seulement). */
type MoreRoom = { key: number; roomId: string; guestCount: string; childCount: string };

function parseMoreRooms(json?: string): MoreRoom[] {
  try {
    const list = JSON.parse(json ?? "[]") as { roomId?: string; guestCount?: number; childCount?: number }[];
    return Array.isArray(list)
      ? list.map((r, i) => ({ key: i, roomId: String(r.roomId ?? ""), guestCount: String(r.guestCount ?? 1), childCount: String(r.childCount ?? 0) }))
      : [];
  } catch {
    return [];
  }
}

type FrozenLine = { id: string; sourceId: string | null; label: string; unit: ExtraUnit; unitPrice: number; chosen?: number | null };
type Quote = { nights: number; computed: number; accommodation: number; lines: StayLine[]; total: number };

/** Cases à cocher : lignes figées de la réservation puis catalogue pas encore pris. */
type Choice = { value: string; label: string; unit: ExtraUnit; price: number; frozen: boolean; chosen?: number | null; maxQuantity?: number | null };

/** Cases à cocher : lignes figées de la réservation puis catalogue pas encore pris. */
function choices(
  frozen: FrozenLine[],
  catalog: { id: string; label: string; unit: ExtraUnit; price: number; maxQuantity?: number | null }[],
): Choice[] {
  return [
    // Ligne figée « par séjour » : maximum actuel de l'option d'origine, jamais sous le nombre déjà pris (comme le serveur).
    ...frozen.map((l) => ({
      value: l.id,
      label: l.label,
      unit: l.unit,
      price: l.unitPrice,
      frozen: true,
      chosen: l.chosen,
      maxQuantity: l.unit === "per_stay" ? Math.max(l.chosen ?? 1, catalog.find((x) => x.id === l.sourceId)?.maxQuantity ?? 1) : null,
    })),
    ...catalog
      .filter((x) => !frozen.some((l) => l.sourceId === x.id))
      .map((x) => ({ value: x.id, label: x.label, unit: x.unit, price: x.price, frozen: false, maxQuantity: x.maxQuantity })),
  ];
}

export default function ManualBookingForm({
  rooms,
  today,
  tomorrow,
  defaultRoomId,
  edit,
  extras = [],
  fees = [],
  taxEnabled = false,
}: {
  rooms: RoomOption[];
  /** Catalogue actif. */
  extras?: CatalogExtra[];
  /** Fees actifs (toutes chambres ; filtrés selon la chambre choisie). */
  fees?: CatalogFee[];
  /** Taxe de séjour activée : champ enfants + case d'exonération. */
  taxEnabled?: boolean;
  today: string;
  tomorrow: string;
  defaultRoomId?: string;
  edit?: BookingEdit;
}) {
  const [state, action, pending] = useActionState<ManualBookingState, FormData>(
    edit ? updateBookingManual.bind(null, edit.id) : createBookingManual,
    null,
  );
  // Après une erreur, la saisie ; sinon, en modification, le séjour actuel.
  const v = state?.values ?? edit?.values ?? {};
  const fe = state?.fieldErrors ?? {};
  const sharedDates = (edit?.dossierRooms ?? 1) > 1;

  // Total en direct : l'hôte voit le prix AVANT d'enregistrer (même calcul que l'enregistrement).
  const formRef = useRef<HTMLFormElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [keepPrice, setKeepPrice] = useState(state?.values?.keepPrice === "on");
  // Une case par ligne existante (valeur = id de ligne, prix figé) puis par élément du catalogue
  // pas encore pris (valeur = id catalogue, prix actuel). Contrôlé : survit au remontage après erreur.
  const [roomId, setRoomId] = useState(v.roomId ?? defaultRoomId ?? "");
  // Dossier de plusieurs chambres (création) : mêmes dates, même voyageur, une ligne par chambre en plus.
  const [moreRooms, setMoreRooms] = useState<MoreRoom[]>(() => (edit ? [] : parseMoreRooms(v.moreRooms)));
  const nextKey = useRef(moreRooms.length);
  const roomIds = [roomId, ...moreRooms.map((m) => m.roomId).filter(Boolean)];
  const multi = moreRooms.length > 0;
  const updateMore = (key: number, patch: Partial<MoreRoom>) =>
    setMoreRooms((list) => list.map((m) => (m.key === key ? { ...m, ...patch } : m)));
  const [roomQuotes, setRoomQuotes] = useState<{ roomId: string; total: number | null }[]>([]);
  // Options réservées à d'autres chambres masquées : leur case disparaît, rien n'est envoyé.
  // Plusieurs chambres : une option apparaît si l'une d'elles la propose (appliquée à celles qui la proposent).
  const extraChoices = choices(edit?.lines ?? [], extras.filter((x) => roomIds.some((r) => matchesRoom(x, r))));
  const [chosenExtras, setChosenExtras] = useState<string[]>(() => edit?.lines.map((l) => l.id) ?? []);
  // Nombre au choix des options, borné par le séjour saisi (le serveur borne aussi) :
  // lits de la chambre choisie, voyageurs saisis, nuits du devis.
  const maxBeds = Math.max(1, ...roomIds.map((id) => rooms.find((r) => r.id === id)?.maxBeds ?? 1));
  const [guests, setGuests] = useState(Math.max(1, Number(v.guestCount) || 1));
  const [counts, setCounts] = useState<Record<string, number>>({});
  // Fees : cochés d'office à la création ; en modification, seuls ceux déjà sur la réservation.
  const feeChoices = choices(edit?.feeLines ?? [], fees.filter((f) => roomIds.some((r) => matchesRoom(f, r))));
  const [chosenFees, setChosenFees] = useState<string[]>(() =>
    edit ? edit.feeLines.map((l) => l.id) : fees.map((f) => f.id),
  );
  const refreshQuote = () => {
    clearTimeout(timer.current);
    // Différé : le sélecteur de date met à jour le champ texte après l'événement.
    timer.current = setTimeout(async () => {
      const f = formRef.current;
      if (!f) return;
      const fd = new FormData(f);
      const val = (n: string) => String(fd.get(n) ?? "");
      const more = parseMoreRooms(val("moreRooms"));
      setGuests(Math.max(1, ...[val("guestCount"), ...more.map((m) => m.guestCount)].map((g) => Math.floor(Number(g)) || 1)));
      const extraIds = fd.getAll("extraIds").map(String);
      const feeIds = fd.getAll("feeIds").map(String);
      // Chaque chambre ne reçoit que les options et frais qu'elle propose (comme l'enregistrement).
      const scoped = (ids: string[], catalog: { id: string; roomIds: string[] }[], room: string) =>
        ids.filter((id) => {
          const item = catalog.find((x) => x.id === id);
          return !item || matchesRoom(item, room);
        });
      const quoteFor = (room: string, guestCount: string, childCount: string) =>
        quoteManualBooking({
          roomId: room,
          checkIn: val("checkIn"),
          checkOut: val("checkOut"),
          guestCount,
          childCount,
          extraIds: more.length > 0 ? scoped(extraIds, extras, room) : extraIds,
          extraQuantities: extraQuantitiesFrom(fd.entries()),
          feeIds: more.length > 0 ? scoped(feeIds, fees, room) : feeIds,
          waiveTax: fd.get("waiveTax") === "on",
          agreedPrice: more.length > 0 ? "" : val("agreedPrice"),
          keepPrice: fd.get("keepPrice") === "on",
          bookingId: edit?.id,
        });
      const [main, ...others] = await Promise.all([
        quoteFor(val("roomId"), val("guestCount"), val("childCount")),
        ...more.map((m) => quoteFor(m.roomId, m.guestCount, m.childCount)),
      ]);
      setQuote(main);
      setRoomQuotes(
        more.length > 0
          ? [{ roomId: val("roomId"), total: main?.total ?? null }, ...more.map((m, i) => ({ roomId: m.roomId, total: others[i]?.total ?? null }))]
          : [],
      );
    }, 300);
  };
  // Re-chiffre après chaque envoi ; edit.id ne change pas pendant la vie du formulaire.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(refreshQuote, [state, moreRooms]);
  // Le lien du conflit ouvre le mois de l'arrivée saisie (mois 0-indexé, comme le calendrier).
  const arrival = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v.checkIn ?? "");
  const calendarHref = arrival
    ? `/admin/calendrier?year=${arrival[3]}&month=${Number(arrival[2]) - 1}`
    : "/admin/calendrier";

  return (
    <form
      // Remonte le formulaire à chaque réponse : les defaultValue (dont le <select>) reprennent la saisie.
      key={JSON.stringify(v)}
      ref={formRef}
      action={action}
      onChange={refreshQuote}
      style={{
        background: "var(--admin-surface)",
        border: "1px solid var(--admin-border)",
        borderRadius: "var(--admin-radius)",
        padding: 24,
      }}
    >
      {/* Un conflit s'affiche à côté du bouton (panneau « Forcer ») ; les autres erreurs ici. */}
      {state?.error && !state.conflict && (
        <div role="alert">
          <StatusBanner variant="error">{state.error}</StatusBanner>
        </div>
      )}

      <Field label={multi ? "Chambre 1 *" : "Chambre *"} error={fe.roomId}>
        <AdminSelect name="roomId" required defaultValue={roomId} onChange={(e) => setRoomId(e.target.value)}>
          <option value="">Sélectionner…</option>
          {rooms.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} — {formatEuros(c.pricePerNight)} / nuit
            </option>
          ))}
        </AdminSelect>
      </Field>

      <div className="grid grid-cols-2 gap-3.5">
        <Field label="Arrivée *" error={fe.checkIn}>
          <DateInput name="checkIn" required defaultValue={v.checkIn ?? today} readOnly={sharedDates} />
        </Field>
        <Field label="Départ *" error={fe.checkOut}>
          <DateInput name="checkOut" required defaultValue={v.checkOut ?? tomorrow} readOnly={sharedDates} />
        </Field>
      </div>
      {sharedDates && (
        <p data-dossier-dates className="-mt-2 mb-3.5 text-[12px] leading-[1.5]" style={{ color: "var(--admin-text-muted)" }}>
          Dates communes aux {edit?.dossierRooms} chambres du Dossier : elles ne changent pas pour une seule chambre.
          Le nom, l&apos;email et le téléphone, eux, s&apos;appliquent à tout le Dossier.
        </p>
      )}

      <div
        aria-live="polite"
        className="mb-3.5 px-3.5 py-2.5 rounded-lg text-[13px] flex flex-wrap items-baseline justify-between gap-x-3"
        style={{ background: "var(--admin-surface-2)", color: "var(--admin-text-muted)" }}
      >
        {multi && quote ? (
          <>
            <span data-dossier-quote>
              {quote.nights} nuit{quote.nights > 1 ? "s" : ""} :{" "}
              {roomQuotes.map((q, i) => (
                <span key={i}>
                  {i > 0 && " + "}
                  {rooms.find((r) => r.id === q.roomId)?.name ?? "Chambre ?"}{" "}
                  {q.total === null ? "—" : formatEuros(q.total)}
                </span>
              ))}
              , options, frais et taxe compris
            </span>
            <span className="tabular-nums">
              Total {roomQuotes.length} chambres{" "}
              <strong className="text-[15px]" style={{ color: "var(--admin-text)" }}>
                {roomQuotes.some((q) => q.total === null)
                  ? "—"
                  : formatEuros(roomQuotes.reduce((n, q) => Math.round((n + (q.total ?? 0)) * 100) / 100, 0))}
              </strong>
            </span>
          </>
        ) : quote ? (
          <>
            <span>
              {quote.nights} nuit{quote.nights > 1 ? "s" : ""}, tarifs et règles appliqués
              {quote.lines.length > 0 && <> : hébergement {formatEuros(quote.accommodation)}</>}
              {quote.lines.map((l, i) => (
                <span key={i} data-quote-line={l.kind}>
                  {" "}+ {l.label} {l.exempt ? "exonérée" : formatEuros(l.total)}
                  {!l.exempt && l.quantity > 1 && ` (${l.quantity} × ${formatEuros(l.unitPrice)})`}
                </span>
              ))}
            </span>
            <span className="tabular-nums">
              {edit && (
                <>
                  Ancien total {formatEuros(edit.oldTotal)} →{" "}
                </>
              )}
              {edit ? "Nouveau total" : "Total calculé"}{" "}
              <strong className="text-[15px]" style={{ color: "var(--admin-text)" }}>
                {formatEuros(quote.total)}
              </strong>
            </span>
          </>
        ) : (
          <span>Choisissez une chambre et des dates pour voir le prix.</span>
        )}
      </div>

      {/* Inutile de proposer de garder un total identique au nouveau. */}
      {edit && quote && (quote.total !== edit.oldTotal || keepPrice) && (
        <label
          className="flex items-start gap-2.5 mb-3.5 cursor-pointer"
          style={{ color: "var(--admin-text)" }}
        >
          <input
            type="checkbox"
            name="keepPrice"
            className="mt-0.5"
            style={{ accentColor: "var(--admin-primary)" }}
            defaultChecked={state ? v.keepPrice === "on" : false}
            onChange={(e) => setKeepPrice(e.target.checked)}
          />
          <span className="text-[13px] leading-snug">
            {quote.lines.length > 0 || edit.oldAccommodation !== edit.oldTotal
              ? `Garder l'ancien prix de l'hébergement (${formatEuros(edit.oldAccommodation)}), options et frais en plus`
              : `Garder l'ancien total (${formatEuros(edit.oldTotal)})`}
          </span>
        </label>
      )}

      {edit?.paidOnline != null && quote && (() => {
        // Déjà payé en ligne : rien n'est débité ni remboursé automatiquement, l'hôte règle l'écart.
        const diff = Math.round((quote.total - edit.paidOnline) * 100) / 100;
        if (diff === 0) return null;
        return (
          <p
            data-paid-difference
            className="mb-3.5 px-3.5 py-2.5 rounded-lg text-[12.5px] leading-[1.5]"
            style={{ background: "#FEF9C3", color: "#92400E" }}
          >
            Déjà payé en ligne : {formatEuros(edit.paidOnline)}.{" "}
            {diff > 0
              ? `Différence à régler avec le client : +${formatEuros(diff)}.`
              : `À rembourser depuis Stripe : ${formatEuros(-diff)}.`}{" "}
            Rien n&apos;est débité ni remboursé automatiquement.
          </p>
        );
      })()}

      <Field
        label="Prix convenu"
        hint={
          multi
            ? "Plusieurs chambres : enregistrez, puis modifiez le prix de chaque chambre depuis sa réservation."
            : "Optionnel : un prix d'hébergement négocié avec le client remplace le prix calculé. Les options et frais s'y ajoutent."
        }
        error={fe.agreedPrice}
      >
        <AdminInput
          disabled={multi}
          name="agreedPrice"
          type="text"
          inputMode="decimal"
          placeholder={quote ? String(quote.computed) : "ex : 250"}
          defaultValue={v.agreedPrice}
        />
      </Field>

      <div className="grid grid-cols-2 gap-3.5">
        <Field label="Prénom" error={fe.guestFirstName}>
          <AdminInput name="guestFirstName" type="text" maxLength={100} autoComplete="off" defaultValue={v.guestFirstName} />
        </Field>
        <Field label="Nom *" error={fe.guestLastName}>
          <AdminInput name="guestLastName" type="text" required maxLength={100} autoComplete="off" defaultValue={v.guestLastName} />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3.5">
        <Field label={multi ? "Voyageurs ch. 1 *" : "Voyageurs *"} error={fe.guestCount}>
          <AdminInput
            name="guestCount"
            type="number"
            min="1"
            required
            defaultValue={v.guestCount ?? 1}
          />
        </Field>
      </div>

      {taxEnabled && (
        <div className="grid grid-cols-2 gap-3.5 items-end">
          <Field label="Dont enfants (−18 ans)" error={fe.childCount} hint="Exonérés de taxe de séjour.">
            <AdminInput name="childCount" type="number" min="0" defaultValue={v.childCount ?? 0} />
          </Field>
          <label className="flex items-start gap-2.5 mb-3.5 cursor-pointer" style={{ color: "var(--admin-text)" }}>
            <input
              type="checkbox"
              name="waiveTax"
              className="mt-0.5"
              style={{ accentColor: "var(--admin-primary)" }}
              defaultChecked={state ? v.waiveTax === "on" : edit?.taxExempt}
            />
            <span className="text-[13px] leading-snug">
              Exonérer de la taxe de séjour
              <span className="block text-[12px]" style={{ color: "var(--admin-text-muted)" }}>
                Saisonnier, hébergement d&apos;urgence… Reste visible dans l&apos;export.
              </span>
            </span>
          </label>
        </div>
      )}

      {!edit && (
        <fieldset className="mb-3.5" data-testid="more-rooms">
          <legend className="sr-only">Autres chambres du même séjour</legend>
          <input type="hidden" name="moreRooms" value={JSON.stringify(moreRooms.map(({ roomId: r, guestCount, childCount }) => ({ roomId: r, guestCount: Number(guestCount) || 0, childCount: Number(childCount) || 0 })))} />
          {moreRooms.map((m, i) => (
            <div
              key={m.key}
              data-more-room={i}
              className="mb-2.5 px-3.5 pt-3 pb-0.5 rounded-lg"
              style={{ background: "var(--admin-surface-2)", border: "1px solid var(--admin-border-light)" }}
            >
              <div className="flex items-center justify-between gap-2 mb-2">
                <p className="text-[12px] font-bold uppercase" style={{ color: "var(--admin-text-muted)", letterSpacing: "0.06em" }}>
                  Chambre {i + 2}
                </p>
                <button
                  type="button"
                  onClick={() => setMoreRooms((list) => list.filter((x) => x.key !== m.key))}
                  className="text-[12.5px] font-semibold underline underline-offset-2 min-h-[36px] px-1"
                  style={{ color: "var(--admin-text-muted)" }}
                >
                  Retirer
                </button>
              </div>
              <Field label={`Chambre ${i + 2} *`} error={fe[`moreRoomId_${i}`]}>
                <AdminSelect value={m.roomId} required onChange={(e) => updateMore(m.key, { roomId: e.target.value })}>
                  <option value="">Sélectionner…</option>
                  {rooms
                    .filter((c) => c.id === m.roomId || !roomIds.includes(c.id))
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} — {formatEuros(c.pricePerNight)} / nuit
                      </option>
                    ))}
                </AdminSelect>
              </Field>
              <div className="grid grid-cols-2 gap-3.5">
                <Field label="Voyageurs *" error={fe[`moreGuestCount_${i}`]}>
                  <AdminInput type="number" min="1" required value={m.guestCount} onChange={(e) => updateMore(m.key, { guestCount: e.target.value })} />
                </Field>
                {taxEnabled && (
                  <Field label="Dont enfants">
                    <AdminInput type="number" min="0" value={m.childCount} onChange={(e) => updateMore(m.key, { childCount: e.target.value })} />
                  </Field>
                )}
              </div>
            </div>
          ))}
          {rooms.length > roomIds.length && (
            <button
              type="button"
              data-add-room
              onClick={() => {
                const key = nextKey.current++;
                setMoreRooms((list) => [...list, { key, roomId: "", guestCount: "1", childCount: "0" }]);
              }}
              className="admin-btn admin-btn--ghost"
            >
              + Ajouter une chambre
            </button>
          )}
          {multi && (
            <p className="mt-2 text-[12px] leading-[1.5]" style={{ color: "var(--admin-text-muted)" }}>
              Un seul Dossier : mêmes dates et même client pour toutes les chambres. Options et frais cochés
              s&apos;appliquent à chaque chambre qui les propose.
            </p>
          )}
        </fieldset>
      )}

      {feeChoices.length > 0 && (
        <fieldset className="mb-3.5" data-testid="manual-fees">
          <legend className="text-[13px] font-semibold mb-1.5" style={{ color: "var(--admin-text)" }}>
            Frais
          </legend>
          {feeChoices.map((x) => {
            const checked = chosenFees.includes(x.value);
            return (
              <label key={x.value} className="flex items-start gap-2.5 py-1 cursor-pointer" style={{ color: "var(--admin-text)" }}>
                <input
                  type="checkbox"
                  name="feeIds"
                  value={x.value}
                  checked={checked}
                  className="mt-0.5"
                  style={{ accentColor: "var(--admin-primary)" }}
                  onChange={() =>
                    setChosenFees((ids) => (checked ? ids.filter((id) => id !== x.value) : [...ids, x.value]))
                  }
                />
                <span className="text-[13px] leading-snug">
                  {x.label}{" "}
                  <span style={{ color: "var(--admin-text-muted)" }}>
                    {x.price === 0 ? "· gratuit" : `· ${formatEuros(x.price)} ${EXTRA_UNIT_LABELS[x.unit]}`}
                    {x.frozen && " · prix de la réservation"}
                  </span>
                </span>
              </label>
            );
          })}
        </fieldset>
      )}

      {extraChoices.length > 0 && (
        <fieldset className="mb-3.5" data-testid="manual-extras">
          <legend className="text-[13px] font-semibold mb-1.5" style={{ color: "var(--admin-text)" }}>
            Options
          </legend>
          {extraChoices.map((x) => {
            const checked = chosenExtras.includes(x.value);
            const stay = { nights: Math.max(1, quote?.nights ?? 1), guests, beds: maxBeds };
            const max = chosenMax(x, stay);
            const pick = checked && max > 1;
            // Choix en cours > nombre enregistré > tout le séjour (affiché comme le maximum).
            const shown = resolveChosen(x.unit, max, counts[x.value], x.chosen) ?? max;
            return (
              <div key={x.value}>
              <label className="flex items-start gap-2.5 py-1 cursor-pointer" style={{ color: "var(--admin-text)" }}>
                <input
                  type="checkbox"
                  name="extraIds"
                  value={x.value}
                  checked={checked}
                  className="mt-0.5"
                  style={{ accentColor: "var(--admin-primary)" }}
                  onChange={() =>
                    setChosenExtras((ids) => (checked ? ids.filter((id) => id !== x.value) : [...ids, x.value]))
                  }
                />
                <span className="text-[13px] leading-snug">
                  {x.label}{" "}
                  <span style={{ color: "var(--admin-text-muted)" }}>
                    {x.price === 0 ? "· gratuit" : `· ${formatEuros(x.price)} ${EXTRA_UNIT_LABELS[x.unit]}`}
                    {x.frozen && " · prix de la réservation"}
                  </span>
                </span>
              </label>
              {pick && (
                <label className="flex items-center gap-2 pl-7 pb-1.5 text-[12.5px]" style={{ color: "var(--admin-text-muted)" }}>
                  {CHOSEN_WORDS[x.unit].question}
                  <AdminSelect
                    // Envoyé seulement si l'hôte a choisi : sinon le serveur garde le nombre enregistré
                    // ou tout le séjour (pas d'ancien maximum envoyé avant le recalcul du devis).
                    name={counts[x.value] !== undefined ? `extraQty_${x.value}` : undefined}
                    data-testid={`extraQty-${x.value}`}
                    value={shown}
                    onChange={(e) => setCounts((c) => ({ ...c, [x.value]: Number(e.target.value) }))}
                    style={{ width: 130 }}
                  >
                    {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
                      <option key={n} value={n}>
                        {chosenLabel(x.unit, n)}
                      </option>
                    ))}
                  </AdminSelect>
                </label>
              )}
              </div>
            );
          })}
        </fieldset>
      )}

      <Field label="Email client *" error={fe.guestEmail}>
        <AdminInput name="guestEmail" type="email" required defaultValue={v.guestEmail} />
      </Field>

      <Field label="Téléphone" error={fe.guestPhone}>
        <AdminInput name="guestPhone" type="tel" defaultValue={v.guestPhone} />
      </Field>

      <Field label="Notes internes">
        <AdminTextarea name="notes" rows={2} defaultValue={v.notes} />
      </Field>

      {/* « Forcer » n'apparaît qu'après un vrai conflit : c'est un override, pas un réglage. */}

      {edit && (
        <label
          className="flex items-start gap-2.5 pt-1 pb-1 cursor-pointer"
          style={{ color: "var(--admin-text)" }}
        >
          <input
            type="checkbox"
            name="notifyGuest"
            className="mt-0.5"
            style={{ accentColor: "var(--admin-primary)" }}
            defaultChecked={state ? v.notifyGuest === "on" : true}
          />
          <span className="text-[13px] leading-snug">
            Prévenir le client par email
            <span className="block text-[12px]" style={{ color: "var(--admin-text-muted)" }}>
              Il reçoit le nouveau récapitulatif (dates, chambre, total). Décochez si vous l&apos;avez déjà prévenu.
            </span>
          </span>
        </label>
      )}

      {/* « Forcer » n'apparaît qu'après un vrai conflit, collé au bouton : la décision et son effet au même endroit. */}
      {state?.conflict && (
        <div
          role="alert"
          data-force-panel
          className="mt-1 mb-1 px-3.5 py-3 rounded-lg"
          style={{ background: "#FEF3C7", border: "1px solid #FCD34D", color: "#92400E" }}
        >
          <p className="text-[13px] font-bold leading-snug">
            {state.error}{" "}
            <Link href={calendarHref} className="font-semibold underline underline-offset-2">
              Voir le calendrier
            </Link>
          </p>
          <p className="text-[12.5px] leading-[1.5] mt-1">
            {state.clash?.kind === "booking"
              ? `${state.clash.guestName} occupe déjà la chambre : enregistrer quand même y mettra deux clients en même temps. À faire seulement si vous déplacez l'un des deux ensuite.`
              : state.clash?.kind === "ical"
                ? "Si c'est la même réservation, recopiée ici, vous pouvez enregistrer. Sinon, deux clients arriveront le même soir."
                : "Enregistrez quand même si ce blocage n'a plus lieu d'être."}
          </p>
          <label className="flex items-start gap-2.5 mt-2.5 cursor-pointer" style={{ color: "var(--admin-text)" }}>
            <input
              type="checkbox"
              name="force"
              className="mt-0.5"
              style={{ accentColor: "var(--admin-primary)" }}
            />
            <span className="text-[13px] font-semibold leading-snug">Enregistrer quand même</span>
          </label>
        </div>
      )}

      <div className="flex gap-3 pt-2">
        <button
          type="submit"
          disabled={pending}
          className="admin-btn"
          style={{ background: "var(--admin-primary)", color: "#fff", border: "none" }}
        >
          {pending ? "Enregistrement…" : edit ? "Enregistrer les modifications" : "Enregistrer"}
        </button>
        <Link
          href={edit ? `/admin/reservations/${edit.id}` : "/admin/reservations"}
          className="admin-btn"
          style={{ color: "var(--admin-text-muted)", background: "none", border: "none" }}
        >
          Retour
        </Link>
      </div>
    </form>
  );
}
