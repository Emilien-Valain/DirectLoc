"use client";

import TermsNotice from "@/components/public/TermsNotice";
import { useActionState, useState } from "react";
import Link from "next/link";
import { createDossierPublic, type DossierBookingState, type PlannedRoom } from "@/lib/actions/dossier-public";
import ExtraOptions from "@/components/public/ExtraOptions";
import GuestFields from "@/components/public/GuestFields";
import { formatEuros } from "@/lib/utils";
import {
  bedLimit,
  chosenMax,
  grandTotal,
  matchesRoom,
  priceExtraLine,
  resolveChosen,
  type ExtraLine,
} from "@/lib/extras";
import { touristTaxLine, type TouristTax } from "@/lib/tourist-tax";
import { distributeGuests, validateCombination, type CombinationError } from "@/lib/room-combination";
import { combinationErrorMessage, partyLabel, plural } from "@/lib/dossier-messages";
import type { CatalogExtra } from "@/lib/queries/extras";
import type { CatalogFee } from "@/lib/queries/fees";

/** Chambre libre pour le séjour, prix calculé par le serveur (hébergement seul). */
type FreeRoom = {
  id: string;
  name: string;
  capacity: number;
  beds: number | null;
  photos: unknown;
  totalPrice: number;
  /** Prix de chaque nuit : base de la taxe de séjour en %. */
  nightPrices: number[];
};

type Host = {
  phone?: string;
  checkInTime?: string;
  checkOutTime?: string;
  /** Documents légaux publiés : mention d'acceptation sous le bouton (résumé du niveau d'annulation). */
  terms?: { summary: string | null } | null;
};

/** Bornes des sélecteurs du groupe : pas de plafond lié aux chambres (cf. recherche). */
const MAX_ADULTS = 30;
const MAX_MINORS = 20;

const fmtDate = (s: string) =>
  new Date(s + "T00:00:00Z").toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "long", timeZone: "UTC" });

const range = (from: number, to: number) => Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i);

/**
 * Formulaire « réserver plusieurs chambres » (Dossier, ADR-0012). Le voyageur part de la
 * combinaison proposée, ajoute / retire / échange une chambre, corrige la répartition, choisit
 * les options de chaque chambre, saisit son identité une fois. Totaux affichés = même calcul
 * que le serveur (lib/extras, lib/tourist-tax), qui recalcule tout de toute façon.
 */
export default function DossierForm({
  checkIn,
  checkOut,
  nights,
  adults: initialAdults,
  minors: initialMinors,
  rooms,
  initial,
  dropped = false,
  cancelled = false,
  extras,
  fees,
  touristTax,
  host = {},
  demo = false,
  via = "",
  share = "",
}: {
  checkIn: string;
  checkOut: string;
  nights: number;
  adults: number;
  minors: number;
  rooms: FreeRoom[];
  initial: PlannedRoom[];
  /** Une chambre demandée dans l'URL n'est plus libre. */
  dropped?: boolean;
  /** Retour de Stripe après abandon du paiement. */
  cancelled?: boolean;
  extras: CatalogExtra[];
  fees: CatalogFee[];
  touristTax?: TouristTax;
  host?: Host;
  demo?: boolean;
  /** Slug du Voisin qui a renvoyé le voyageur ; le serveur le revérifie. */
  via?: string;
  /** Partage de groupe (`slug:adultes:mineurs`) ; le serveur le revalide. */
  share?: string;
}) {
  const [state, action, submitting] = useActionState<DossierBookingState, FormData>(createDossierPublic, null);
  const v = state?.values ?? {};

  const [party, setParty] = useState({ adults: initialAdults, minors: initialMinors });
  const [selection, setSelection] = useState<PlannedRoom[]>(initial);
  const [chosen, setChosen] = useState<Record<string, string[]>>({});
  const [counts, setCounts] = useState<Record<string, Record<string, number>>>({});
  const [gone, setGone] = useState<string[]>([]);

  // Réponse du serveur : chambres prises entre-temps retirées, nouvelle combinaison appliquée.
  const [seen, setSeen] = useState(state);
  if (state !== seen) {
    setSeen(state);
    if (state?.gone) setGone((g) => [...new Set([...g, ...state.gone!])]);
    if (state?.suggestion) setSelection(state.suggestion);
  }

  const free = rooms.filter((r) => !gone.includes(r.id));
  const byId = new Map(rooms.map((r) => [r.id, r]));
  const nameOf = (id: string) => byId.get(id)?.name ?? "Une chambre";
  const selected = selection.filter((s) => byId.has(s.roomId));
  const others = free.filter((r) => !selected.some((s) => s.roomId === r.id));

  /** Toute modification de chambres redistribue les voyageurs automatiquement ; le voyageur corrige ensuite. */
  const reassign = (ids: string[], p = party) => {
    const list = ids.map((id) => byId.get(id)!).filter(Boolean);
    setSelection(distributeGuests(list, p.adults, p.minors).map(({ roomId, adults, minors }) => ({ roomId, adults, minors })));
  };
  const ids = selected.map((s) => s.roomId);
  const setPerson = (roomId: string, key: "adults" | "minors", n: number) =>
    setSelection((sel) => sel.map((s) => (s.roomId === roomId ? { ...s, [key]: n } : s)));

  // ── Validation (même module que le serveur) ──
  const check = validateCombination(
    free,
    selected.map((s) => ({ roomId: s.roomId, guests: s.adults + s.minors, minors: s.minors })),
    party.adults,
    party.minors,
  );
  const errors: CombinationError[] = check.ok ? [] : check.errors;
  const roomErrors = (id: string) => errors.filter((e) => "roomId" in e && e.roomId === id);
  const globalErrors = [...new Set(errors.filter((e) => !("roomId" in e)).map((e) => combinationErrorMessage(e, nameOf)))];
  const placed = selected.reduce((s, r) => s + r.adults + r.minors, 0);
  const people = party.adults + party.minors;

  // ── Prix de chaque chambre ──
  const extrasFor = (roomId: string) => extras.filter((x) => matchesRoom(x, roomId));
  const priced = selected.map((s) => {
    const room = byId.get(s.roomId)!;
    const guests = Math.max(1, s.adults + s.minors);
    const stay = { nights, guests, beds: bedLimit({ beds: room.beds, capacity: room.capacity }) };
    const picked = chosen[s.roomId] ?? [];
    const own = counts[s.roomId] ?? {};
    const extraLines: ExtraLine[] = extrasFor(s.roomId)
      .filter((x) => picked.includes(x.id))
      .map((x) =>
        priceExtraLine(
          { sourceId: x.id, label: x.label, unit: x.unit, unitPrice: x.price },
          stay,
          resolveChosen(x.unit, chosenMax(x, stay), own[x.id]),
        ),
      );
    const chargeLines: ExtraLine[] = fees
      .filter((f) => matchesRoom(f, s.roomId))
      .map((f) => priceExtraLine({ sourceId: f.id, label: f.label, unit: f.unit, unitPrice: f.price }, { ...stay, beds: 1 }));
    const tax = touristTaxLine(touristTax, room.nightPrices, guests, Math.min(s.minors, guests));
    if (tax) chargeLines.push(tax);
    return { s, room, stay, extraLines, chargeLines, total: grandTotal(room.totalPrice, [...extraLines, ...chargeLines]) };
  });
  const grand = grandTotal(0, priced.map((p) => ({ total: p.total })));
  const valid = check.ok && selected.length > 0;
  const payBlocked = submitting || !valid;

  // Ce que le serveur reçoit : choix seulement, jamais un montant.
  const plan = selected.map((s) => {
    const offered = new Set(extrasFor(s.roomId).map((x) => x.id));
    const picked = (chosen[s.roomId] ?? []).filter((id) => offered.has(id));
    const own = counts[s.roomId] ?? {};
    return {
      roomId: s.roomId,
      guests: s.adults + s.minors,
      minors: s.minors,
      extraIds: picked,
      extraQuantities: Object.fromEntries(picked.flatMap((id) => (own[id] !== undefined ? [[id, own[id]]] : []))),
    };
  });

  const applyToAll = (fromId: string) => {
    const src = chosen[fromId] ?? [];
    const srcCounts = counts[fromId] ?? {};
    const nextChosen = { ...chosen };
    const nextCounts = { ...counts };
    for (const id of ids) {
      if (id === fromId) continue;
      const offered = new Set(extrasFor(id).map((x) => x.id));
      nextChosen[id] = src.filter((x) => offered.has(x));
      nextCounts[id] = Object.fromEntries(Object.entries(srcCounts).filter(([x]) => offered.has(x)));
    }
    setChosen(nextChosen);
    setCounts(nextCounts);
  };

  return (
    <form action={action} key={JSON.stringify(v)} className="s-book s-dossier">
      {via && <input type="hidden" name="via" value={via} />}
      {share && <input type="hidden" name="share" value={share} />}
      <input type="hidden" name="checkIn" value={checkIn} />
      <input type="hidden" name="checkOut" value={checkOut} />
      <input type="hidden" name="adults" value={party.adults} />
      <input type="hidden" name="minors" value={party.minors} />
      <input type="hidden" name="plan" value={JSON.stringify(plan)} />

      <div className="s-book-main">
        {cancelled && <p className="s-alert">Le paiement a été annulé. Vous pouvez réessayer ci-dessous.</p>}
        {dropped && !state && (
          <p className="s-alert" data-testid="dossier-dropped">
            Une chambre choisie n&apos;est plus disponible pour ces dates : vérifiez la proposition ci-dessous.
          </p>
        )}
        {state?.error && (
          <p role="alert" data-testid="booking-error" className="s-alert is-bad">
            {state.error}
          </p>
        )}

        <fieldset className="s-group">
          <legend className="s-h3">Votre séjour</legend>
          <p className="s-dossier-dates">
            <span>
              Du <strong>{fmtDate(checkIn)}</strong> au <strong>{fmtDate(checkOut)}</strong> · {plural(nights, "nuit", "nuits")}
            </span>
            <Link href="/#dates" className="s-link">
              Changer de dates
            </Link>
          </p>
          <div className="s-grid-2 s-dossier-party">
            <div className="s-field">
              <label htmlFor="party-adults">Adultes</label>
              <select
                id="party-adults"
                value={party.adults}
                onChange={(e) => {
                  const p = { ...party, adults: Number(e.target.value) };
                  setParty(p);
                  reassign(ids, p);
                }}
              >
                {range(1, Math.max(MAX_ADULTS, party.adults)).map((n) => (
                  <option key={n} value={n}>
                    {plural(n, "adulte", "adultes")}
                  </option>
                ))}
              </select>
            </div>
            <div className="s-field">
              <label htmlFor="party-minors">Enfants (−18 ans)</label>
              <select
                id="party-minors"
                value={party.minors}
                onChange={(e) => {
                  const p = { ...party, minors: Number(e.target.value) };
                  setParty(p);
                  reassign(ids, p);
                }}
              >
                {range(0, Math.max(MAX_MINORS, party.minors)).map((n) => (
                  <option key={n} value={n}>
                    {n === 0 ? "Aucun enfant" : plural(n, "enfant", "enfants")}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <p className={`s-status ${placed === people && check.ok ? "is-good" : "is-warn"}`} data-testid="dossier-placed">
            {plural(placed, "voyageur placé", "voyageurs placés")} sur {people}, dans {plural(selected.length, "chambre", "chambres")}
          </p>
        </fieldset>

        <section className="s-dossier-rooms" aria-labelledby="dossier-rooms-title">
          <h2 id="dossier-rooms-title" className="s-h3">
            Vos chambres
          </h2>
          {globalErrors.length > 0 && (
            <div className="s-status-row" data-testid="dossier-errors" aria-live="polite">
              {globalErrors.map((m) => (
                <span key={m} className="s-status is-bad">
                  {m}
                </span>
              ))}
            </div>
          )}

          <ol className="s-dossier-list">
            {priced.map(({ s, room, stay }, i) => {
              const errs = roomErrors(s.roomId);
              const roomExtras = extrasFor(s.roomId);
              return (
                <li key={s.roomId} className="s-group s-dossier-room" data-testid="dossier-room" data-room-id={s.roomId}>
                  <div className="s-dossier-head">
                    <span className="s-dossier-num" aria-hidden="true">
                      {i + 1}
                    </span>
                    <div className="s-dossier-title">
                      <h3 className="s-dossier-name">{room.name}</h3>
                      <p className="s-hint">
                        Jusqu&apos;à {plural(room.capacity, "personne", "personnes")} · {formatEuros(room.totalPrice)} le séjour
                      </p>
                    </div>
                  </div>

                  <div className="s-grid-2">
                    <div className="s-field">
                      <label htmlFor={`adults-${s.roomId}`}>Adultes</label>
                      <select
                        id={`adults-${s.roomId}`}
                        value={s.adults}
                        aria-invalid={errs.length > 0 || undefined}
                        onChange={(e) => setPerson(s.roomId, "adults", Number(e.target.value))}
                      >
                        {range(0, Math.max(room.capacity, s.adults)).map((n) => (
                          <option key={n} value={n}>
                            {n}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="s-field">
                      <label htmlFor={`minors-${s.roomId}`}>Enfants</label>
                      <select
                        id={`minors-${s.roomId}`}
                        value={s.minors}
                        aria-invalid={errs.length > 0 || undefined}
                        onChange={(e) => setPerson(s.roomId, "minors", Number(e.target.value))}
                      >
                        {range(0, Math.max(room.capacity, s.minors)).map((n) => (
                          <option key={n} value={n}>
                            {n}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  {errs.length > 0 && (
                    <div className="s-status-row" aria-live="polite">
                      {errs.map((e) => (
                        <span key={e.code} className="s-status is-bad" data-testid="dossier-room-error">
                          {combinationErrorMessage(e, nameOf)}
                        </span>
                      ))}
                    </div>
                  )}

                  {roomExtras.length > 0 && (
                    <div className="s-dossier-extras" data-testid="booking-extras">
                      <p className="s-dossier-sub">Options de cette chambre</p>
                      <ExtraOptions
                        extras={roomExtras}
                        chosen={chosen[s.roomId] ?? []}
                        counts={counts[s.roomId] ?? {}}
                        stay={stay}
                        idPrefix={`${s.roomId}-`}
                        onToggle={(id) =>
                          setChosen((c) => {
                            const cur = c[s.roomId] ?? [];
                            return { ...c, [s.roomId]: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] };
                          })
                        }
                        onCount={(id, n) => setCounts((c) => ({ ...c, [s.roomId]: { ...(c[s.roomId] ?? {}), [id]: n } }))}
                      />
                      {selected.length > 1 && (
                        <button type="button" className="s-chip-btn" onClick={() => applyToAll(s.roomId)}>
                          Appliquer ces options à toutes les chambres
                        </button>
                      )}
                    </div>
                  )}

                  <div className="s-dossier-actions">
                    {others.length > 0 && (
                      <div className="s-field s-field-mid">
                        <label htmlFor={`swap-${s.roomId}`}>Échanger contre</label>
                        <select
                          id={`swap-${s.roomId}`}
                          value=""
                          onChange={(e) => {
                            const to = e.target.value;
                            if (!to) return;
                            setChosen((c) => ({ ...c, [to]: c[s.roomId] ?? [] }));
                            setCounts((c) => ({ ...c, [to]: c[s.roomId] ?? {} }));
                            reassign(ids.map((id) => (id === s.roomId ? to : id)));
                          }}
                        >
                          <option value="">Choisir une autre chambre…</option>
                          {others.map((o) => (
                            <option key={o.id} value={o.id}>
                              {o.name} · {o.capacity} pers. · {formatEuros(o.totalPrice)}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                    {selected.length > 1 && (
                      <button
                        type="button"
                        className="s-chip-btn is-quiet"
                        onClick={() => reassign(ids.filter((id) => id !== s.roomId))}
                      >
                        Retirer cette chambre
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>

          {others.length > 0 && (
            <div className="s-group s-dossier-add" data-testid="dossier-add">
              <p className="s-dossier-sub">Ajouter une chambre</p>
              <ul className="s-search-rooms">
                {others.map((o) => (
                  <li key={o.id}>
                    <button
                      type="button"
                      className="s-search-room"
                      onClick={() => reassign([...ids, o.id])}
                      aria-label={`Ajouter ${o.name}`}
                    >
                      <span>{o.name}</span>
                      <span className="s-search-room-meta">
                        {o.capacity} pers. max · {formatEuros(o.totalPrice)} le séjour
                      </span>
                      <span className="s-search-room-go">Ajouter</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        <GuestFields values={v} fieldErrors={state?.fieldErrors} />

        {/* Récapitulatif contracté, collé en bas d'écran sur téléphone (masqué ≥ 900px). */}
        <div className="s-book-bar">
          <p className="s-book-bar-total">
            <span>Total</span>
            <strong>{valid ? formatEuros(grand) : "—"}</strong>
          </p>
          <button type="submit" disabled={payBlocked} className="s-btn" data-testid="booking-bar-submit">
            {submitting ? "Redirection…" : "Payer"}
          </button>
        </div>
      </div>

      <aside className="s-summary" data-testid="booking-summary">
        <div className="s-summary-card">
          <p className="s-summary-room">
            {selected.length === 1 ? byId.get(selected[0].roomId)!.name : plural(selected.length, "chambre", "chambres")}
          </p>
          <dl className="s-rows">
            <Row label="Arrivée" value={fmtDate(checkIn)} />
            <Row label="Départ" value={fmtDate(checkOut)} />
            <Row label="Durée" value={plural(nights, "nuit", "nuits")} />
            <Row label="Voyageurs" value={partyLabel(party.adults, party.minors)} />
          </dl>

          {priced.map(({ s, room, extraLines, chargeLines, total }) => (
            <div key={s.roomId} className="s-summary-stay" data-testid="dossier-summary-room">
              <p className="s-summary-sub">
                <span>{room.name}</span>
                <span>{formatEuros(total)}</span>
              </p>
              <ul className="s-nights">
                <li>
                  <span>
                    {partyLabel(s.adults, s.minors)} · {plural(nights, "nuit", "nuits")}
                  </span>
                  <span>{formatEuros(room.totalPrice)}</span>
                </li>
                {[...extraLines, ...chargeLines].map((l) => (
                  <li key={(l.sourceId ?? "") + l.label}>
                    <span>
                      {l.label}
                      {l.quantity > 1 && l.sourceId && <em> · {l.quantity} × {formatEuros(l.unitPrice)}</em>}
                    </span>
                    <span>{l.total === 0 ? "Offert" : formatEuros(l.total)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}

          {!valid && <p className="s-hint">Complétez la répartition des voyageurs pour voir le total.</p>}
          <p className="s-total">
            <span>Total</span>
            <span data-testid="booking-summary-total">{valid ? formatEuros(grand) : "—"}</span>
          </p>
        </div>
        <button type="submit" disabled={payBlocked} data-testid="booking-submit" className="s-btn s-btn-block">
          {submitting ? "Redirection vers le paiement…" : valid ? `Payer ${formatEuros(grand)} et confirmer` : "Procéder au paiement"}
        </button>
        <div className="s-reassure" data-testid="booking-reassure">
          {host.terms && <TermsNotice summary={host.terms.summary} />}
          {demo && (
            <p className="s-note" data-testid="demo-test-card">
              Démo : carte de test 4242 4242 4242 4242, date future, CVC au choix
            </p>
          )}
          <p className="s-hint">Un seul paiement sécurisé par Stripe pour toutes les chambres. Confirmation envoyée par email.</p>
          {(host.checkInTime || host.checkOutTime) && (
            <p className="s-hint">
              {[host.checkInTime && `Arrivée : ${host.checkInTime}`, host.checkOutTime && `Départ : ${host.checkOutTime}`]
                .filter(Boolean)
                .join(" · ")}
            </p>
          )}
          {host.phone && (
            <p className="s-hint">
              Une question avant de payer ? <a href={`tel:${host.phone}`}>{host.phone}</a>
            </p>
          )}
        </div>
      </aside>
    </form>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="s-row">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
