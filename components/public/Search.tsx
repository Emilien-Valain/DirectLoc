"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
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
  | {
      ok: false;
      reason: "insufficient_capacity" | "not_enough_adults" | "invalid_input";
      maxCapacity: number;
      rules?: string[];
    };

/** Bloc « Complet » : créneaux proches chez l'hôte et Voisins du réseau (ADR-0013). */
type FullOffer = {
  slots: { checkIn: string; checkOut: string }[];
  voisins: { name: string; city: string | null; distanceKm: number; slug: string }[];
  /** Partage : l'hôte loge `host`, un seul Voisin loge `rest` (ADR-0013). */
  share?: {
    voisin: { name: string; city: string | null; distanceKm: number; slug: string };
    host: { adults: number; minors: number };
    rest: { adults: number; minors: number };
  } | null;
};

const isoOk = (v: string | null): v is string =>
  !!v && /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(v + "T00:00:00Z").toISOString().startsWith(v);

const dayMonth = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("fr-FR", { day: "numeric", month: "long", timeZone: "UTC" });
const shortDay = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("fr-FR", { day: "numeric", month: "short", timeZone: "UTC" });
const km = (n: number) => `${n.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} km`;

/** Pas de plafond lié aux chambres : un groupe se loge sur plusieurs chambres. */
const MAX_ADULTS = 30;
const MAX_MINORS = 20;


function addDay(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().split("T")[0];
}

/** Recherche de dates de l'accueil : renvoie les chambres libres, avec lien direct vers la réservation. */
export default function Search({
  title = "Vos dates",
  submitLabel = "Voir les disponibilités",
}: { title?: string; submitLabel?: string } = {}) {
  const today = parisToday();
  // Recherche pré-remplie par l'URL (Renvoi d'un Voisin) ; `via` suit jusqu'à la réservation, sans cookie.
  const sp = useSearchParams();
  const pre = (() => {
    const ci = sp.get("checkIn");
    const co = sp.get("checkOut");
    const a = Number(sp.get("adults"));
    const m = Number(sp.get("minors") ?? "0");
    if (!isoOk(ci) || !isoOk(co) || co <= ci || ci < today) return null;
    if (!Number.isInteger(a) || a < 1 || a > MAX_ADULTS || !Number.isInteger(m) || m < 0 || m > MAX_MINORS) return null;
    return { checkIn: ci, checkOut: co, adults: a, minors: m };
  })();
  const viaRaw = sp.get("via");
  const via = viaRaw && /^[a-z0-9-]{1,63}$/.test(viaRaw) ? viaRaw : null;
  const viaQ = via ? `&via=${via}` : "";
  // Partage de groupe : suit l'URL jusqu'au paiement (le serveur revalide), sans cookie.
  const shareRaw = sp.get("share");
  const share = shareRaw && /^[a-z0-9-]{1,63}:\d{1,2}:\d{1,2}$/.test(shareRaw) ? shareRaw : null;
  const shareQ = share ? `&share=${encodeURIComponent(share)}` : "";
  const [checkIn, setCheckIn] = useState(pre?.checkIn ?? "");
  const [checkOut, setCheckOut] = useState(pre?.checkOut ?? "");
  const [adults, setAdults] = useState(pre?.adults ?? 1);
  const [minors, setMinors] = useState(pre?.minors ?? 0);
  const [offer, setOffer] = useState<FullOffer | null>(null);
  const [asked, setAsked] = useState<{ checkIn: string; checkOut: string; adults: number; minors: number } | null>(null);
  const guests = adults + minors;
  const [status, setStatus] = useState<Status>("idle");
  const [rooms, setRooms] = useState<Room[]>([]);
  const [group, setGroup] = useState<Group | null>(null);

  const past = !!checkIn && checkIn < today;
  const valid = !!checkIn && !!checkOut && checkOut > checkIn && !past;
  const nights = valid
    ? Math.round((Date.parse(checkOut) - Date.parse(checkIn)) / 86_400_000)
    : 0;

  function search(e: React.FormEvent) {
    e.preventDefault();
    if (!valid) {
      setStatus("invalid");
      return;
    }
    return run(checkIn, checkOut);
  }

  // Arrivée par un Renvoi : la recherche part toute seule.
  const auto = useRef(false);
  useEffect(() => {
    if (pre && !auto.current) {
      auto.current = true;
      void run(pre.checkIn, pre.checkOut);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function run(checkIn: string, checkOut: string) {
    setStatus("searching");
    setOffer(null);
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
      setAsked({ checkIn, checkOut, adults, minors });
      // Complet : jamais bloquant, rien d'affiché si le réseau n'a rien à proposer.
      if (found.length === 0 && !combo?.ok) {
        try {
          const q = new URLSearchParams({ from: checkIn, to: checkOut, adults: String(adults), minors: String(minors) });
          const r = await fetch(`/api/network/full?${q}`, { cache: "no-store" });
          if (r.ok) setOffer(await r.json());
        } catch {}
      }
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
            {title}
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
                : submitLabel}
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
              ? noCombinationMessage(group.reason, guests, adults, group.maxCapacity, group.rules)
              : guests > 1
                ? `Aucune chambre libre pour ${guests} personnes à ces dates. Essayez d'autres dates.`
                : "Complet pour ces dates. Essayez d'autres dates."}
          </p>
        )}
        {status === "done" && rooms.length === 0 && !group?.ok && asked && offer && (offer.slots.length > 0 || offer.voisins.length > 0 || !!offer.share) && (
          <div className="s-full-slip" data-testid="full-slip">
            <p className="s-full-title">
              Complet du {dayMonth(asked.checkIn)} au {dayMonth(asked.checkOut)}
            </p>
            {offer.slots.length > 0 && (
              <>
                <p className="s-full-lead">Chez nous, ces dates proches sont libres :</p>
                <ul className="s-full-list" data-testid="full-slots">
                  {offer.slots.map((sl) => (
                    <li key={sl.checkIn}>
                      <button
                        type="button"
                        className="s-full-pick"
                        onClick={() => {
                          setCheckIn(sl.checkIn);
                          setCheckOut(sl.checkOut);
                          void run(sl.checkIn, sl.checkOut);
                        }}
                      >
                        Du {shortDay(sl.checkIn)} au {shortDay(sl.checkOut)}
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {offer.voisins.length > 0 && (
              <>
                <p className="s-full-lead">Ces hébergements voisins peuvent accueillir tout votre groupe à ces dates :</p>
                <ul className="s-full-list" data-testid="full-voisins">
                  {offer.voisins.map((v) => (
                    <li key={v.slug}>
                      <a
                        className="s-full-pick"
                        href={`/voisin/${v.slug}?${new URLSearchParams({ checkIn: asked.checkIn, checkOut: asked.checkOut, adults: String(asked.adults), minors: String(asked.minors) })}`}
                      >
                        {v.name}
                      </a>
                      <span>
                        {v.city ? `${v.city} · ` : ""}
                        {km(v.distanceKm)}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {offer.share && (
              <>
                <p className="s-full-lead">Aucun hébergement ne loge tout votre groupe, mais vous pouvez le répartir :</p>
                <p className="s-full-share" data-testid="full-share">
                  Nous logeons {offer.share.host.adults + offer.share.host.minors} personnes ici, {offer.share.voisin.name}
                  {offer.share.voisin.city ? ` (${offer.share.voisin.city})` : ""} ({km(offer.share.voisin.distanceKm)}) peut loger les{" "}
                  {offer.share.rest.adults + offer.share.rest.minors} autres.
                </p>
                <p className="s-full-mention" data-testid="full-share-mention">
                  Votre groupe sera réparti sur 2 hébergements à {km(offer.share.voisin.distanceKm)}, avec 2 réservations et 2 paiements séparés.
                </p>
                <a
                  className="s-btn s-full-go"
                  data-testid="full-share-go"
                  href={`/?${new URLSearchParams({
                    checkIn: asked.checkIn,
                    checkOut: asked.checkOut,
                    adults: String(offer.share.host.adults),
                    minors: String(offer.share.host.minors),
                    share: `${offer.share.voisin.slug}:${offer.share.rest.adults}:${offer.share.rest.minors}`,
                  })}#dates`}
                >
                  Réserver nos {offer.share.host.adults + offer.share.host.minors} places d&apos;abord
                </a>
              </>
            )}
          </div>
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
              href={groupHref(checkIn, checkOut, adults, minors, group.rooms.map((r) => r.id), via, share)}
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
                      href={`/reserver/${r.id}?checkIn=${checkIn}&checkOut=${checkOut}&guests=${guests}${minors > 0 ? `&children=${minors}` : ""}${viaQ}${shareQ}`}
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
                href={groupHref(checkIn, checkOut, adults, minors, undefined, via, share)}
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
function groupHref(checkIn: string, checkOut: string, adults: number, minors: number, rooms?: string[], via?: string | null, share?: string | null) {
  const q = new URLSearchParams({ checkIn, checkOut, adults: String(adults), minors: String(minors) });
  if (rooms) q.set("rooms", rooms.join(","));
  if (via) q.set("via", via);
  if (share) q.set("share", share);
  return `/reserver/chambres?${q}`;
}
