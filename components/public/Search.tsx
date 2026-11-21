"use client";

import { useState } from "react";
import Link from "next/link";
import { parisToday } from "@/lib/date-windows";
import { formatEuros } from "@/lib/utils";
import DateField from "@/components/public/DateField";
import { noCombinationMessage, partyLabel } from "@/lib/dossier-messages";

type Room = {
  id: string;
  name: string;
  slug: string;
  pricePerNight: string;
  minPricePerNight?: number;
  capacity: number;
};

type Status = "idle" | "invalid" | "searching" | "done" | "error";

/** Groupe trop grand pour une chambre : combinaison proposée par /api/rooms/combination. */
type Group =
  | {
      ok: true;
      totalPrice: number;
      rooms: { id: string; name: string; capacity: number; adults: number; minors: number }[];
    }
  | { ok: false; reason: "insufficient_capacity" | "not_enough_adults" | "invalid_input"; maxCapacity: number };

/** Pas de plafond lié aux chambres : un groupe se loge sur plusieurs chambres. */
const MAX_ADULTS = 30;
const MAX_MINORS = 20;


function addDay(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().split("T")[0];
}

/** Recherche de dates de l'accueil : renvoie les chambres libres, avec lien direct vers la réservation. */
export default function Search() {
  const today = parisToday();
  const [checkIn, setCheckIn] = useState("");
  const [checkOut, setCheckOut] = useState("");
  const [adults, setAdults] = useState(1);
  const [minors, setMinors] = useState(0);
  const guests = adults + minors;
  const [status, setStatus] = useState<Status>("idle");
  const [rooms, setRooms] = useState<Room[]>([]);
  const [group, setGroup] = useState<Group | null>(null);

  const past = !!checkIn && checkIn < today;
  const valid = !!checkIn && !!checkOut && checkOut > checkIn && !past;
  const nights = valid
    ? Math.round((Date.parse(checkOut) - Date.parse(checkIn)) / 86_400_000)
    : 0;

  async function search(e: React.FormEvent) {
    e.preventDefault();
    if (!valid) {
      setStatus("invalid");
      return;
    }
    setStatus("searching");
    try {
      const params = new URLSearchParams({ from: checkIn, to: checkOut, guests: String(guests) });
      const res = await fetch(`/api/rooms/available?${params}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error();
      const data = await res.json();
      const found: Room[] = data.rooms ?? [];
      // Aucune chambre seule pour tout le groupe : plusieurs chambres (une réservation).
      let combo: Group | null = null;
      if (found.length === 0 && guests > 1) {
        const q = new URLSearchParams({ from: checkIn, to: checkOut, adults: String(adults), minors: String(minors) });
        const r = await fetch(`/api/rooms/combination?${q}`, { cache: "no-store" });
        if (!r.ok) throw new Error();
        combo = await r.json();
      }
      setRooms(found);
      setGroup(combo);
      setStatus("done");
    } catch {
      setStatus("error");
    }
  }

  return (
    <div className="s-search" id="dates">
      <form
        className="s-search-form"
        onSubmit={search}
        aria-label="Rechercher des dates"
      >
        <div className="s-sign-face">
          <h2 className="s-search-title">
            Vos dates
            <svg className="s-sign-arrow" viewBox="0 0 40 20" aria-hidden="true">
              <path d="M0 7h26V0l14 10-14 10v-7H0z" />
            </svg>
          </h2>
          <div className="s-search-fields">
            <DateField
              id="search-checkin"
              label="Arrivée"
              required
              min={today}
              value={checkIn}
              onChange={(v) => {
                setCheckIn(v);
                setStatus("idle");
                if (v && (!checkOut || v >= checkOut)) setCheckOut(addDay(v));
              }}
            />
            <DateField
              id="search-checkout"
              label="Départ"
              required
              min={checkIn ? addDay(checkIn) : today}
              value={checkOut}
              onChange={(v) => {
                setCheckOut(v);
                setStatus("idle");
              }}
            />
            <div className="s-party">
            <div className="s-field">
              <label htmlFor="search-adults">Adultes</label>
              <select
                id="search-adults"
                value={adults}
                onChange={(e) => {
                  setAdults(Number(e.target.value));
                  setStatus("idle");
                }}
              >
                {Array.from({ length: MAX_ADULTS }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
            <div className="s-field">
              <label htmlFor="search-minors" title="Moins de 18 ans">
                Enfants
              </label>
              <select
                id="search-minors"
                value={minors}
                aria-describedby="search-minors-hint"
                onChange={(e) => {
                  setMinors(Number(e.target.value));
                  setStatus("idle");
                }}
              >
                {Array.from({ length: MAX_MINORS + 1 }, (_, i) => i).map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
              <span id="search-minors-hint" className="s-sr-only">
                Moins de 18 ans
              </span>
            </div>
            </div>
            <button
              type="submit"
              className="s-btn"
              disabled={status === "searching"}
            >
              {status === "searching"
                ? "Recherche…"
                : "Voir les disponibilités"}
            </button>
          </div>
        </div>
      </form>

      <div className="s-search-result" aria-live="polite">
        {status === "invalid" && (
          <p className="s-note is-bad" data-testid="search-dates-error">
            {past
              ? "L'arrivée est déjà passée. Choisissez une date à partir d'aujourd'hui."
              : "Le départ doit être après l'arrivée."}
          </p>
        )}
        {status === "error" && (
          <p className="s-note is-bad">
            La recherche n&apos;a pas abouti. Réessayez dans un instant.
          </p>
        )}
        {status === "done" && rooms.length === 0 && !(group?.ok) && (
          <p className="s-note is-bad" data-testid="search-no-room">
            {group && !group.ok
              ? noCombinationMessage(group.reason, guests, adults, group.maxCapacity)
              : guests > 1
                ? `Aucune chambre libre pour ${guests} personnes à ces dates. Essayez d'autres dates.`
                : "Complet pour ces dates. Essayez d'autres dates."}
          </p>
        )}
        {status === "done" && rooms.length === 0 && group?.ok && (
          <div className="s-search-group" data-testid="search-group">
            <p className="s-note is-good">
              {group.rooms.length} chambres pour {guests} personnes, {nights} nuit{nights > 1 ? "s" : ""}
            </p>
            <ul className="s-search-rooms">
              {group.rooms.map((r) => (
                <li key={r.id} className="s-search-room is-static">
                  <span>{r.name}</span>
                  <span className="s-search-room-meta">
                    {partyLabel(r.adults, r.minors)} · {r.capacity} pers. max
                  </span>
                </li>
              ))}
            </ul>
            <p className="s-hint">
              {formatEuros(group.totalPrice)} d&apos;hébergement pour le séjour, options et taxes en plus.
              Vous pourrez changer de chambres et la répartition à l&apos;étape suivante.
            </p>
            <Link
              href={groupHref(checkIn, checkOut, adults, minors, group.rooms.map((r) => r.id))}
              className="s-btn s-btn-block"
            >
              Réserver ces {group.rooms.length} chambres
            </Link>
          </div>
        )}
        {status === "done" && rooms.length > 0 && (
          <>
            <p className="s-note is-good">
              {rooms.length === 1
                ? "1 chambre libre"
                : `${rooms.length} chambres libres`}{" "}
              pour {nights} nuit{nights > 1 ? "s" : ""}
              {guests > 1 && `, ${guests} personnes`}
            </p>
            <ul className="s-search-rooms">
              {rooms.map((r) => {
                const price = r.minPricePerNight ?? parseFloat(r.pricePerNight);
                return (
                  <li key={r.id}>
                    <Link
                      href={`/reserver/${r.id}?checkIn=${checkIn}&checkOut=${checkOut}&guests=${guests}${minors > 0 ? `&children=${minors}` : ""}`}
                      className="s-search-room"
                    >
                      <span>{r.name}</span>
                      <span className="s-search-room-meta">
                        {r.capacity} pers. · {formatEuros(price)} / nuit
                      </span>
                      <span className="s-search-room-go">Réserver</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
            {guests > 1 && (
              <Link
                href={groupHref(checkIn, checkOut, adults, minors)}
                className="s-link"
                data-testid="search-several-rooms"
              >
                Plutôt plusieurs chambres ?
              </Link>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** Page de réservation de plusieurs chambres ; sans `rooms`, le serveur propose la combinaison. */
function groupHref(checkIn: string, checkOut: string, adults: number, minors: number, rooms?: string[]) {
  const q = new URLSearchParams({ checkIn, checkOut, adults: String(adults), minors: String(minors) });
  if (rooms) q.set("rooms", rooms.join(","));
  return `/reserver/chambres?${q}`;
}
