"use client";

import { useActionState, useState, useEffect, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { createBookingPublic, type PublicBookingState } from "@/lib/actions/bookings-public";
import RoomPhoto from "@/components/public/RoomPhoto";
import { parisToday } from "@/lib/date-windows";
import DateField from "@/components/public/DateField";
import { formatEuros } from "@/lib/utils";
import {
  EXTRA_UNIT_LABELS,
  bedLimit,
  grandTotal,
  hasChosenQuantity,
  priceExtraLine,
  type ExtraLine,
} from "@/lib/extras";
import type { CatalogExtra } from "@/lib/queries/extras";
import type { CatalogFee } from "@/lib/queries/fees";
import { touristTaxLine, type TouristTax } from "@/lib/tourist-tax";

type Room = {
  id: string;
  name: string;
  pricePerNight: string;
  capacity: number;
  /** Lits de la chambre (null = non renseigné → capacité) : borne des options « par lit ». */
  beds?: number | null;
  photos?: unknown;
};

type AvailabilityStatus = "idle" | "checking" | "available" | "unavailable";

interface RuleViolation {
  rule: string;
  message: string;
}

interface NightPrice {
  date: string;
  price: number;
  basePrice: number;
  appliedRule: string | null;
}

interface EffectiveRules {
  minStay: number | null;
  maxStay: number | null;
  allowedCheckInDays: number[] | null;
  allowedCheckOutDays: number[] | null;
}

const DAY_NAMES_FR = [
  "dimanche",
  "lundi",
  "mardi",
  "mercredi",
  "jeudi",
  "vendredi",
  "samedi",
];

// « Aujourd'hui » = date à Paris, comme le serveur (bookingPublicSchema refuse une arrivée passée).
function getToday(): string {
  return parisToday();
}

function getTomorrow(): string {
  return addDay(parisToday());
}

function addDay(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().split("T")[0];
}

// Centimes affichés dès qu'il y en a : le total doit être exactement celui débité par Stripe.
const fmtCurrency = formatEuros;

const fmtDateShort = (s: string): string =>
  new Date(s + "T12:00:00").toLocaleDateString("fr-FR", {
    day: "numeric",
    month: "long",
  });

type Host = { phone?: string; checkInTime?: string; checkOutTime?: string };

export default function BookingForm({
  room,
  extras = [],
  fees = [],
  touristTax,
  host = {},
  demo = false,
}: {
  room: Room;
  extras?: CatalogExtra[];
  /** Fees actifs qui s'appliquent à cette chambre, ajoutés d'office (ADR-0011). */
  fees?: CatalogFee[];
  touristTax?: TouristTax;
  host?: Host;
  /** Hôtel démo : paiement Stripe en mode test. */
  demo?: boolean;
}) {
  const today = getToday();
  const tomorrow = getTomorrow();
  const searchParams = useSearchParams();
  const wasCancelled = searchParams.get("cancelled") === "true";
  const [state, action, submitting] = useActionState<PublicBookingState, FormData>(
    createBookingPublic,
    null,
  );
  const v = state?.values ?? {};

  const [checkIn, setCheckIn] = useState(searchParams.get("checkIn") ?? "");
  const [checkOut, setCheckOut] = useState(searchParams.get("checkOut") ?? "");
  // Saisie brute : le champ peut être vidé puis retapé ; borné seulement à la sortie du champ.
  // Pré-rempli depuis la recherche de l'accueil (?guests=), borné à la capacité.
  const [guestInput, setGuestInput] = useState(() => {
    const g = parseInt(searchParams.get("guests") ?? "", 10);
    return String(Number.isNaN(g) ? 1 : Math.min(Math.max(1, g), room.capacity));
  });
  const parsedGuests = parseInt(guestInput, 10);
  const guestCount = Number.isNaN(parsedGuests) ? 1 : Math.min(Math.max(1, parsedGuests), room.capacity);
  const [childInput, setChildInput] = useState(v.childCount ?? "0");
  const parsedChildren = parseInt(childInput, 10);
  const childCount = Number.isNaN(parsedChildren) ? 0 : Math.min(Math.max(0, parsedChildren), guestCount);
  const datesInverted = !!checkIn && !!checkOut && checkOut <= checkIn;
  const datesPast = !!checkIn && checkIn < today;
  const [fetchedAvailability, setAvailability] = useState<AvailabilityStatus>("idle");
  // Dates incomplètes ou incohérentes : rien à vérifier, statut dérivé plutôt que posé dans l'effet.
  const datesValid =
    !!checkIn && !!checkOut && new Date(checkOut + "T00:00:00Z") > new Date(checkIn + "T00:00:00Z");
  const availability: AvailabilityStatus = datesValid ? fetchedAvailability : "idle";
  const [nights, setNights] = useState(0);
  const [totalPrice, setTotalPrice] = useState(0);
  const [nightPrices, setNightPrices] = useState<NightPrice[]>([]);
  const [violations, setViolations] = useState<RuleViolation[]>([]);
  // Contrôlé (pas defaultChecked) : survit au remontage du formulaire après une erreur serveur.
  const [chosenExtras, setChosenExtras] = useState<string[]>([]);
  // Options « par lit » : nombre de lits voulu (par défaut tous).
  const maxBeds = bedLimit({ beds: room.beds ?? null, capacity: room.capacity });
  const [bedCounts, setBedCounts] = useState<Record<string, number>>({});
  const [rules, setRules] = useState<EffectiveRules | null>(null);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const params = new URLSearchParams({ roomId: room.id });
    fetch(`/api/rules?${params}`, { cache: "no-store" })
      .then((r) => r.json())
      .then(setRules)
      .catch(() => {});
  }, [room.id]);

  useEffect(() => {
    if (!datesValid) return;

    const checkInDate = new Date(checkIn + "T00:00:00Z");
    const checkOutDate = new Date(checkOut + "T00:00:00Z");

    if (debounceRef.current) clearTimeout(debounceRef.current);

    debounceRef.current = setTimeout(async () => {
      setAvailability("checking");
      try {
        const params = new URLSearchParams({
          roomId: room.id,
          from: checkIn,
          to: checkOut,
        });
        const res = await fetch(`/api/availability?${params}`, { cache: "no-store" });
        if (!res.ok) {
          setAvailability("idle");
          return;
        }
        const data = await res.json();
        setViolations(data.violations ?? []);

        if (data.available) {
          const pricingParams = new URLSearchParams({
            roomId: room.id,
            from: checkIn,
            to: checkOut,
          });
          const pricingRes = await fetch(`/api/pricing?${pricingParams}`, {
            cache: "no-store",
          });
          if (pricingRes.ok) {
            const pricing = await pricingRes.json();
            setNights(pricing.nights.length);
            setTotalPrice(pricing.totalPrice);
            setNightPrices(pricing.nights);
          } else {
            const n = Math.round(
              (checkOutDate.getTime() - checkInDate.getTime()) /
                (1000 * 60 * 60 * 24),
            );
            setNights(n);
            setTotalPrice(n * parseFloat(room.pricePerNight));
            setNightPrices([]);
          }
          setAvailability("available");
        } else {
          setAvailability("unavailable");
        }
      } catch {
        setAvailability("idle");
      }
    }, 500);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // `state` : après un refus serveur, la dispo affichée est peut-être périmée.
  }, [checkIn, checkOut, datesValid, room.id, room.pricePerNight, state]);

  const handleCheckInChange = (val: string) => {
    setCheckIn(val);
    if (val && (!checkOut || val >= checkOut)) {
      setCheckOut(addDay(val));
    }
  };

  // Même calcul que le serveur (lib/extras) ; nuits estimées tant que le tarif n'est pas arrivé.
  const stayNights = nights > 0 ? nights : datesValid
    ? Math.round((new Date(checkOut + "T00:00:00Z").getTime() - new Date(checkIn + "T00:00:00Z").getTime()) / 86_400_000)
    : 1;
  const priceOf = (x: CatalogExtra) =>
    priceExtraLine(
      { sourceId: x.id, label: x.label, unit: x.unit, unitPrice: x.price },
      stayNights,
      guestCount,
      hasChosenQuantity(x.unit) ? Math.min(bedCounts[x.id] ?? maxBeds, maxBeds) : undefined,
    );
  const extraLines = extras.filter((x) => chosenExtras.includes(x.id)).map(priceOf);
  const hasValidPricing =
    availability === "available" && violations.length === 0 && totalPrice > 0;
  // Fees et taxe : même calcul que le serveur (lib/extras, lib/tourist-tax).
  const chargeLines: ExtraLine[] = fees.map((f) =>
    priceExtraLine({ sourceId: f.id, label: f.label, unit: f.unit, unitPrice: f.price }, stayNights, guestCount),
  );
  const tax = touristTaxLine(
    touristTax,
    nightPrices.length === stayNights ? nightPrices.map((n) => n.price) : Array(stayNights).fill(totalPrice / stayNights),
    guestCount,
    childCount,
  );
  if (tax) chargeLines.push(tax);
  const grand = grandTotal(totalPrice, [...extraLines, ...chargeLines]);
  // Même règle pour le bouton principal et celui de la barre mobile.
  const payBlocked = submitting || availability !== "available" || violations.length > 0 || datesPast;

  return (
    // Remonte le formulaire à chaque réponse : les defaultValue reprennent la saisie.
    <form action={action} key={JSON.stringify(v)} className="s-book">
      <input type="hidden" name="roomId" value={room.id} />

      <div className="s-book-main">
        {wasCancelled && (
          <p className="s-alert">Le paiement a été annulé. Vous pouvez réessayer ci-dessous.</p>
        )}
        {state?.error && (
          <p role="alert" data-testid="booking-error" className="s-alert is-bad">
            {state.error}
          </p>
        )}

        <fieldset className="s-group">
          <legend className="s-h3">Votre séjour</legend>
          <div className="s-grid-2">
            <DateField
              id="checkIn"
              name="checkIn"
              label="Arrivée"
              required
              min={today}
              value={checkIn}
              onChange={handleCheckInChange}
            />
            <DateField
              id="checkOut"
              name="checkOut"
              label="Départ"
              required
              min={checkIn ? addDay(checkIn) : tomorrow}
              value={checkOut}
              onChange={setCheckOut}
            />
          </div>

          {rules && (rules.minStay || rules.maxStay || rules.allowedCheckInDays || rules.allowedCheckOutDays) && (
            <ul className="s-hint-list">
              {rules.minStay && <li>Séjour de {rules.minStay} nuit{rules.minStay > 1 ? "s" : ""} minimum</li>}
              {rules.maxStay && <li>{rules.maxStay} nuit{rules.maxStay > 1 ? "s" : ""} maximum</li>}
              {rules.allowedCheckInDays && (
                <li>Arrivée le {rules.allowedCheckInDays.map((d) => DAY_NAMES_FR[d]).join(", ")}</li>
              )}
              {rules.allowedCheckOutDays && (
                <li>Départ le {rules.allowedCheckOutDays.map((d) => DAY_NAMES_FR[d]).join(", ")}</li>
              )}
            </ul>
          )}

          <div className="s-status-row" aria-live="polite">
            {datesInverted && (
              <span className="s-status is-bad" data-testid="booking-dates-error">
                Le départ doit être après l&apos;arrivée
              </span>
            )}
            {datesPast && (
              <span className="s-status is-bad" data-testid="booking-dates-error">
                L&apos;arrivée est déjà passée
              </span>
            )}
            {availability === "checking" && <span className="s-status">Vérification…</span>}
            {availability === "available" && violations.length === 0 && (
              <span className="s-status is-good">Disponible</span>
            )}
            {availability === "unavailable" && violations.length === 0 && (
              <span className="s-status is-bad">Non disponible pour ces dates</span>
            )}
            {violations.map((viol, i) => (
              <span key={i} className="s-status is-warn">
                {viol.message}
              </span>
            ))}
          </div>

          <div className="s-field s-field-short">
            <label htmlFor="guestCount">Nombre de personnes</label>
            <input
              id="guestCount"
              type="number"
              name="guestCount"
              required
              min={1}
              max={room.capacity}
              value={guestInput}
              aria-describedby="guestCount-hint"
              onChange={(e) => setGuestInput(e.target.value)}
              onBlur={() => setGuestInput(String(guestCount))}
            />
            <p id="guestCount-hint" className="s-hint">
              Jusqu&apos;à {room.capacity} personne{room.capacity > 1 ? "s" : ""}
            </p>
          </div>
          {touristTax && (
            <div className="s-field s-field-short">
              <label htmlFor="childCount">Dont enfants (−18 ans)</label>
              <input
                id="childCount"
                type="number"
                name="childCount"
                min={0}
                max={guestCount}
                value={childInput}
                aria-describedby="childCount-hint"
                aria-invalid={!!state?.fieldErrors?.childCount}
                onChange={(e) => setChildInput(e.target.value)}
                onBlur={() => setChildInput(String(childCount))}
              />
              <p id="childCount-hint" className="s-hint">
                {state?.fieldErrors?.childCount ?? "Exonérés de taxe de séjour"}
              </p>
            </div>
          )}
        </fieldset>

        {extras.length > 0 && (
          <fieldset className="s-group" data-testid="booking-extras">
            <legend className="s-h3">Options</legend>
            <ul className="s-extras">
              {extras.map((x) => {
                const line = priceOf(x);
                const checked = chosenExtras.includes(x.id);
                return (
                  <li key={x.id}>
                    <label className="s-extra">
                      <input
                        type="checkbox"
                        name="extraIds"
                        value={x.id}
                        checked={checked}
                        onChange={() =>
                          setChosenExtras((ids) => (checked ? ids.filter((id) => id !== x.id) : [...ids, x.id]))
                        }
                      />
                      <span className="s-extra-text">
                        <span className="s-extra-label">{x.label}</span>
                        <span className="s-hint">
                          {x.price === 0 ? "Offert, sur demande" : `${fmtCurrency(x.price)} ${EXTRA_UNIT_LABELS[x.unit]}`}
                          {x.description && <> · {x.description}</>}
                        </span>
                      </span>
                      <span className="s-extra-price" data-testid="booking-extra-price">
                        {line.total === 0 ? "Offert" : fmtCurrency(line.total)}
                      </span>
                    </label>
                    {checked && hasChosenQuantity(x.unit) && maxBeds > 1 && (
                      <div className="s-extra-qty">
                        <label htmlFor={`extraQty-${x.id}`}>Pour combien de lits ?</label>
                        <select
                          id={`extraQty-${x.id}`}
                          name={`extraQty_${x.id}`}
                          value={line.quantity}
                          onChange={(e) => setBedCounts((c) => ({ ...c, [x.id]: Number(e.target.value) }))}
                        >
                          {Array.from({ length: maxBeds }, (_, i) => i + 1).map((n) => (
                            <option key={n} value={n}>
                              {n} lit{n > 1 ? "s" : ""}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </fieldset>
        )}

        <fieldset className="s-group">
          <legend className="s-h3">Pour vous joindre</legend>
          <div className="s-grid-2">
            <div className="s-field">
              <label htmlFor="guestFirstName">Prénom</label>
              <input
                id="guestFirstName"
                type="text"
                name="guestFirstName"
                required
                maxLength={100}
                autoComplete="given-name"
                defaultValue={v.guestFirstName}
                aria-invalid={!!state?.fieldErrors?.guestFirstName || undefined}
              />
            </div>
            <div className="s-field">
              <label htmlFor="guestLastName">Nom</label>
              <input
                id="guestLastName"
                type="text"
                name="guestLastName"
                required
                maxLength={100}
                autoComplete="family-name"
                defaultValue={v.guestLastName}
                aria-invalid={!!state?.fieldErrors?.guestLastName || undefined}
              />
            </div>
            <div className="s-field">
              <label htmlFor="guestEmail">Email</label>
              <input id="guestEmail" type="email" name="guestEmail" required autoComplete="email" defaultValue={v.guestEmail} />
            </div>
            <div className="s-field">
              <label htmlFor="guestPhone">Téléphone</label>
              <input
                id="guestPhone"
                type="tel"
                name="guestPhone"
                required
                autoComplete="tel"
                defaultValue={v.guestPhone}
                aria-invalid={!!state?.fieldErrors?.guestPhone || undefined}
              />
            </div>
          </div>
          <div className="s-field">
            <label htmlFor="guestAddress">Adresse postale</label>
            <input
              id="guestAddress"
              type="text"
              name="guestAddress"
              required
              minLength={5}
              maxLength={300}
              autoComplete="street-address"
              placeholder="12 rue des Lilas, 84000 Avignon"
              defaultValue={v.guestAddress}
              aria-invalid={!!state?.fieldErrors?.guestAddress || undefined}
            />
          </div>
        </fieldset>

        {/* Version contractée du récapitulatif, collée en bas d'écran sur téléphone (masquée ≥ 900px). */}
        {hasValidPricing && (
          <div className="s-book-bar">
            <p className="s-book-bar-total">
              <span>Total</span>
              <strong>{fmtCurrency(grand)}</strong>
            </p>
            <button type="submit" disabled={payBlocked} className="s-btn" data-testid="booking-bar-submit">
              {submitting ? "Redirection…" : "Payer"}
            </button>
          </div>
        )}
      </div>

      <aside className="s-summary" data-testid="booking-summary">
        <Summary
          room={room}
          checkIn={checkIn}
          checkOut={checkOut}
          guestCount={guestCount}
          nights={nights}
          totalPrice={totalPrice}
          extraLines={extraLines}
          chargeLines={chargeLines}
          grand={grand}
          nightPrices={nightPrices}
          hasValidPricing={hasValidPricing}
          availability={availability}
        />
        <button
          type="submit"
          disabled={payBlocked}
          data-testid="booking-submit"
          className="s-btn s-btn-block"
        >
          {submitting
            ? "Redirection vers le paiement…"
            : hasValidPricing
              ? `Payer ${fmtCurrency(grand)} et confirmer`
              : "Procéder au paiement"}
        </button>
        <div className="s-reassure" data-testid="booking-reassure">
          {demo && (
            <p className="s-note" data-testid="demo-test-card">
              Démo : carte de test 4242 4242 4242 4242, date future, CVC au choix
            </p>
          )}
          <p className="s-hint">Paiement sécurisé par Stripe. Confirmation envoyée par email.</p>
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

// ── Récapitulatif réactif (toujours visible : le total s'affiche avant de payer) ──

function Summary({
  room,
  checkIn,
  checkOut,
  guestCount,
  nights,
  totalPrice,
  extraLines,
  chargeLines,
  grand,
  nightPrices,
  hasValidPricing,
  availability,
}: {
  room: Room;
  checkIn: string;
  checkOut: string;
  guestCount: number;
  nights: number;
  totalPrice: number;
  extraLines: ExtraLine[];
  chargeLines: ExtraLine[];
  grand: number;
  nightPrices: NightPrice[];
  hasValidPricing: boolean;
  availability: AvailabilityStatus;
}) {
  const basePrice = parseFloat(room.pricePerNight);
  const hasPerNightRules = nightPrices.some((n) => n.appliedRule);
  const photo = Array.isArray(room.photos) && room.photos.length > 0;

  return (
    <div className="s-summary-card">
      {photo && <RoomPhoto photos={room.photos} alt={room.name} className="s-summary-photo" sizes="(max-width: 900px) 100vw, 340px" />}
      <p className="s-summary-room">{room.name}</p>
      <p className="s-hint">
        Jusqu&apos;à {room.capacity} personne{room.capacity > 1 ? "s" : ""} · {fmtCurrency(basePrice)} / nuit
      </p>

      <dl className="s-rows">
        <Row label="Arrivée" value={checkIn ? fmtDateShort(checkIn) : "—"} testId="booking-summary-checkin" />
        <Row label="Départ" value={checkOut ? fmtDateShort(checkOut) : "—"} testId="booking-summary-checkout" />
        <Row label="Durée" value={nights > 0 && hasValidPricing ? `${nights} nuit${nights > 1 ? "s" : ""}` : "—"} testId="booking-summary-nights" />
        <Row label="Voyageurs" value={`${guestCount} pers.`} testId="booking-summary-guests" />
      </dl>

      {hasValidPricing ? (
        hasPerNightRules ? (
          <ul className="s-nights">
            {nightPrices.map((np) => (
              <li key={np.date}>
                <span>
                  {new Date(np.date + "T00:00:00Z").toLocaleDateString("fr-FR", {
                    weekday: "short",
                    day: "numeric",
                    month: "short",
                    timeZone: "UTC",
                  })}
                  {np.appliedRule && <em> · {np.appliedRule}</em>}
                </span>
                <span>{fmtCurrency(np.price)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="s-calc">
            <span>
              {fmtCurrency(basePrice)} × {nights} nuit{nights > 1 ? "s" : ""}
            </span>
            <span>{fmtCurrency(totalPrice)}</span>
          </p>
        )
      ) : null}

      {hasValidPricing && extraLines.length > 0 && (
        <ul className="s-nights" data-testid="booking-summary-extras">
          {extraLines.map((l) => (
            <li key={l.sourceId}>
              <span>
                {l.label}
                {l.quantity > 1 && <em> · {l.quantity} × {fmtCurrency(l.unitPrice)}</em>}
              </span>
              <span>{l.total === 0 ? "Offert" : fmtCurrency(l.total)}</span>
            </li>
          ))}
        </ul>
      )}

      {hasValidPricing && chargeLines.length > 0 && (
        <ul className="s-nights" data-testid="booking-summary-fees">
          {chargeLines.map((l) => (
            <li key={l.sourceId ?? l.label}>
              <span>
                {l.label}
                {l.quantity > 1 && l.sourceId && <em> · {l.quantity} × {fmtCurrency(l.unitPrice)}</em>}
              </span>
              <span>{fmtCurrency(l.total)}</span>
            </li>
          ))}
        </ul>
      )}

      {!hasValidPricing && (
        <p className="s-hint">
          {availability === "checking"
            ? "Calcul du tarif…"
            : availability === "unavailable"
              ? "Choisissez d'autres dates pour voir le tarif."
              : "Choisissez vos dates pour voir le total."}
        </p>
      )}

      <p className="s-total">
        <span>Total</span>
        <span data-testid="booking-summary-total">{hasValidPricing ? fmtCurrency(grand) : "—"}</span>
      </p>
    </div>
  );
}

function Row({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div className="s-row">
      <dt>{label}</dt>
      <dd data-testid={testId}>{value}</dd>
    </div>
  );
}
