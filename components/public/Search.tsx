"use client";

import { useState } from "react";
import Link from "next/link";
import { parisToday } from "@/lib/date-windows";
import { formatEuros } from "@/lib/utils";
import DateField from "@/components/public/DateField";

type Room = {
  id: string;
  name: string;
  slug: string;
  pricePerNight: string;
  minPricePerNight?: number;
  capacity: number;
};

type Status = "idle" | "invalid" | "searching" | "done" | "error";

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
  const [status, setStatus] = useState<Status>("idle");
  const [rooms, setRooms] = useState<Room[]>([]);

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
      const params = new URLSearchParams({ from: checkIn, to: checkOut });
      const res = await fetch(`/api/rooms/available?${params}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error();
      const data = await res.json();
      setRooms(data.rooms ?? []);
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
        {status === "done" && rooms.length === 0 && (
          <p className="s-note is-bad">
            Complet pour ces dates. Essayez d&apos;autres dates.
          </p>
        )}
        {status === "done" && rooms.length > 0 && (
          <>
            <p className="s-note is-good">
              {rooms.length === 1
                ? "1 chambre libre"
                : `${rooms.length} chambres libres`}{" "}
              pour {nights} nuit{nights > 1 ? "s" : ""}
            </p>
            <ul className="s-search-rooms">
              {rooms.map((r) => {
                const price = r.minPricePerNight ?? parseFloat(r.pricePerNight);
                return (
                  <li key={r.id}>
                    <Link
                      href={`/reserver/${r.id}?checkIn=${checkIn}&checkOut=${checkOut}`}
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
          </>
        )}
      </div>
    </div>
  );
}
