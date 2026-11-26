import Link from "next/link";
import Image from "next/image";
import type { Tenant, TenantConfig } from "@/lib/tenant-context";
import Search from "@/components/public/Search";
import SiteMenu from "@/components/public/SiteMenu";
import RoomGallery from "@/components/public/RoomGallery";
import RoomDates from "@/components/public/RoomDates";
import { formatEuros } from "@/lib/utils";
import {
  HomeLocation,
  RoomPrice,
  placeLine,
  sortedPhotos,
  type PublicRoom,
} from "@/components/public/Site";

/**
 * Le Carnet (clé en base : carnet) — un magazine de voyage.
 *
 * Seul template avec son propre balisage pour l'en-tête, l'accueil et la page
 * chambre : les chambres y sont des « articles » numérotés (grand numéro,
 * titre serif, lettrine), que le balisage commun ne porte pas. Données,
 * recherche, carte, galerie et réservation restent celles du site commun ;
 * réservation et confirmation gardent le balisage commun, habillé par
 * templates/carnet.css.
 */

const hasStory = (c: TenantConfig) => Boolean(c.storyTitle || c.storyText);
const num = (i: number) => String(i + 1).padStart(2, "0");

export function CarnetHeader({
  name,
  config,
  showLocation,
}: {
  name: string;
  config: TenantConfig;
  showLocation: boolean;
}) {
  return (
    <header className="s-header c-header">
      <SiteMenu showLocation={showLocation} showStory={hasStory(config)} />
      <nav className="c-nav" aria-label="Navigation principale">
        <Link href="/chambres" className="c-nav-link">
          Chambres
        </Link>
        {hasStory(config) && (
          <Link href="/#la-maison" className="c-nav-link">
            La maison
          </Link>
        )}
        {showLocation && (
          <Link href="/#nous-trouver" className="c-nav-link">
            Nous trouver
          </Link>
        )}
      </nav>
      <Link href="/" className="c-brand">
        {config.logoUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={config.logoUrl} alt="" height={36} className="c-brand-logo" />
        )}
        <span className="c-brand-name">{name}</span>
      </Link>
      <Link href="/#dates" className="c-nav-link c-cta">
        Réserver
      </Link>
    </header>
  );
}

const SMALL = "zéro une deux trois quatre cinq six sept huit neuf dix onze douze".split(" ");
const count = (n: number) => {
  const word = n <= 12 ? SMALL[n] : String(n);
  return `${word[0].toUpperCase()}${word.slice(1)} chambre${n > 1 ? "s" : ""}`;
};

/** Petits mots devant lesquels on coupe le titre (« Une bergerie / dans le bocage »). */
const CUT = /^(dans|à|au|aux|en|sur|sous|près|entre|face|chez|de|du|des|au-dessus|par|pour|avec|et)$/i;

/** Titre en deux lignes, la seconde en italique : coupe au retour à la ligne de l'hôte, sinon au milieu. */
export function splitTitle(title: string): [string, string | null] {
  const byLine = title.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (byLine.length > 1) return [byLine[0], byLine.slice(1).join(" ")];
  const words = title.trim().split(/\s+/);
  if (words.length < 3) return [title.trim(), null];
  const mid = words.length / 2;
  let cut = Math.round(mid);
  let best = Infinity;
  for (let i = 1; i < words.length; i++) {
    if (CUT.test(words[i]) && Math.abs(i - mid) < best) {
      best = Math.abs(i - mid);
      cut = i;
    }
  }
  return [words.slice(0, cut).join(" "), words.slice(cut).join(" ")];
}

/** Nom de chambre : le premier mot droit, la suite en italique (« La Grange »). */
function RoomTitle({ name }: { name: string }) {
  const [first, ...rest] = name.trim().split(/\s+/);
  return (
    <>
      {first}
      {rest.length > 0 && (
        <>
          {" "}
          <em>{rest.join(" ")}</em>
        </>
      )}
    </>
  );
}

/** « Puy du Fou : 8 min » → libellé + valeur ; une ligne sans séparateur reste une valeur seule. */
function splitAccess(line: string): [string | null, string] {
  const m = line.match(/^(.{1,40}?)\s*(?::|—|–)\s+(.+)$/);
  return m ? [m[1], m[2]] : [null, line];
}

function mapsLink(config: TenantConfig) {
  const destination =
    config.latitude != null && config.longitude != null ? `${config.latitude},${config.longitude}` : config.address;
  return (
    config.googleMapsUrl ??
    (destination ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}` : null)
  );
}

export function CarnetHome({
  tenant,
  config,
  rooms,
  totalRooms,
  showLocation,
}: {
  tenant: Tenant;
  config: TenantConfig;
  rooms: PublicRoom[];
  totalRooms: number;
  showLocation: boolean;
}) {
  const [line1, line2] = splitTitle(config.heroTitle ?? tenant.name);
  const place = config.heroEyebrow ?? placeLine(config);
  const photo = config.heroPhoto?.url;
  const pitch = config.heroSubtitle;
  const stats = config.storyStats ?? [];
  const gallery = config.galleryPhotos ?? [];
  const access = config.accessLines ?? [];
  const story = hasStory(config);
  const itinerary = mapsLink(config);
  const fromPrice = rooms.length
    ? Math.min(...rooms.map((r) => Math.min(r.minPrice, parseFloat(r.pricePerNight))))
    : null;

  return (
    <>
      <section className={`s-hero c-hero${photo ? " has-photo" : ""}`}>
        <div className="c-hero-main">
          {place && (
            <p className="c-place">
              <span>{place}</span>
              <span className="c-place-rule" aria-hidden="true" />
            </p>
          )}
          <h1 className="s-title c-title">
            {line1}
            {line2 && (
              <>
                {" "}
                <em>{line2}</em>
              </>
            )}
          </h1>
          {photo && (
            <figure className="c-hero-figure">
              <div className="c-hero-photo">
                <Image src={photo} alt="" fill priority sizes="(max-width: 1000px) 100vw, 800px" />
              </div>
              {pitch && <figcaption>{pitch}</figcaption>}
            </figure>
          )}
        </div>
        <aside className="c-book">
          <Search title="Réserver un séjour" submitLabel="Vérifier les dates" />
        </aside>
      </section>

      {!photo && pitch && (
        <section className="c-wrap c-quote-wrap" aria-label="En quelques mots">
          <blockquote className="c-quote">
            <p>« {pitch} »</p>
          </blockquote>
        </section>
      )}

      {stats.length > 0 && (
        <section id="chiffres-cles" className="c-wrap c-band c-brief" aria-labelledby="c-brief-title">
          <h2 id="c-brief-title" className="c-band-title">
            {config.keyStatsTitle ?? "En bref"}
          </h2>
          <dl className="c-band-cols" data-count={stats.length}>
            {stats.map((s, i) => (
              <div key={`${s.label}-${i}`} className="c-band-col">
                <dd className="c-brief-value">{s.value}</dd>
                <dt className="c-brief-label">{s.label}</dt>
                {s.sub && <dd className="c-brief-sub">{s.sub}</dd>}
              </div>
            ))}
          </dl>
        </section>
      )}

      {rooms.length > 0 && (
        <section className="c-wrap c-rooms" id="chambres" aria-labelledby="c-rooms-title">
          <div className="c-head">
            <h2 id="c-rooms-title" className="s-h2">
              {totalRooms > 1 ? "Les chambres" : "La chambre"}
            </h2>
            <p className="c-label">{count(totalRooms)}</p>
          </div>
          <div className="c-room-grid" data-count={Math.min(rooms.length, 4)}>
            {rooms.map((room, i) => {
              const main = sortedPhotos(room.photos)[0];
              return (
                <Link key={room.id} href={`/chambres/${room.slug}`} className="c-room">
                  <span className="c-room-top">
                    <span className="c-room-num" aria-hidden="true">
                      {num(i)}
                    </span>
                    <span className="c-room-name">{room.name}</span>
                  </span>
                  {main && (
                    <span className="c-room-photo">
                      <Image src={main.url} alt="" fill sizes="(max-width: 640px) 100vw, (max-width: 1000px) 50vw, 400px" />
                    </span>
                  )}
                  {room.description && <span className="c-room-desc">{room.description}</span>}
                  <span className="c-room-foot">
                    <span className="c-room-cap">{room.capacity} pers.</span>
                    <RoomPrice room={room} />
                  </span>
                  <span className="c-room-more" aria-hidden="true">
                    Lire l&apos;article →
                  </span>
                </Link>
              );
            })}
          </div>
          {totalRooms > rooms.length && (
            <Link href="/chambres" className="c-more">
              Voir les {totalRooms} chambres
            </Link>
          )}
        </section>
      )}

      {gallery.length > 0 && (
        <section className="c-wrap c-report" aria-labelledby="c-report-title">
          <div className="c-head">
            <h2 id="c-report-title" className="s-h2">
              La maison <em>en images</em>
            </h2>
          </div>
          <div className="c-report-grid" data-testid="home-gallery" data-count={gallery.length}>
            {gallery.map((p) => (
              <figure key={p.id} className="c-figure">
                <div className="c-figure-img">
                  <Image src={p.url} alt={p.caption ?? ""} fill sizes="(max-width: 700px) 100vw, 60vw" />
                </div>
                {p.caption && <figcaption>{p.caption}</figcaption>}
              </figure>
            ))}
          </div>
        </section>
      )}

      {(story || showLocation) && (
        <div className={`c-wrap c-house${story && showLocation ? " is-pair" : ""}`}>
          {story && (
            <section id="la-maison" className="c-story" aria-labelledby="c-story-title">
              <h2 id="c-story-title" className="c-label">
                La maison
              </h2>
              {config.storyTitle && <p className="c-story-title">{config.storyTitle}</p>}
              {config.storyText && <p className="c-story-text">{config.storyText}</p>}
              {config.storyEyebrow && <p className="c-signature">— {config.storyEyebrow}</p>}
            </section>
          )}
          {showLocation && (
            <div className="c-find">
              {/* L'accès part dans le carnet d'adresses, en bas. */}
              <HomeLocation tenant={tenant} config={{ ...config, accessLines: [] }} />
              {(config.phone || itinerary) && (
                <p className="c-find-actions">
                  {config.phone && (
                    <a href={`tel:${config.phone}`} className="c-pill">
                      Appeler
                    </a>
                  )}
                  {itinerary && (
                    <a href={itinerary} className="c-pill" target="_blank" rel="noopener noreferrer">
                      Itinéraire
                    </a>
                  )}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {access.length > 0 && (
        <section className="c-wrap c-band c-addresses" aria-labelledby="c-addresses-title" data-testid="carnet-adresses">
          <h2 id="c-addresses-title" className="c-band-title">
            Carnet d&apos;adresses
          </h2>
          <dl className="c-band-cols" data-count={access.length}>
            {access.map((line, i) => {
              const [label, value] = splitAccess(line);
              return (
                <div key={i} className="c-band-col">
                  {label && <dt className="c-label">{label}</dt>}
                  <dd className="c-address-value">{value}</dd>
                </div>
              );
            })}
          </dl>
        </section>
      )}

      {fromPrice != null && (
        <div className="c-mobile-bar" data-testid="carnet-mobile-bar">
          <p>
            <span>à partir de</span>
            <strong>
              {formatEuros(fromPrice)} <small>/ nuit</small>
            </strong>
          </p>
          <Link href="/#dates" className="s-btn">
            Réserver
          </Link>
        </div>
      )}
    </>
  );
}

type OtherRoom = PublicRoom & { index: number };

/** Page chambre en « article » : rubrique, grand numéro, titre, photos, récit à lettrine, encart Réserver. */
export function CarnetRoom({
  room,
  index,
  total,
  minPrice,
  facts,
  chargesNote,
  others,
  today,
}: {
  room: PublicRoom;
  index: number;
  total: number;
  minPrice: number;
  facts: [string, string][];
  chargesNote: string | null;
  others: OtherRoom[];
  today: string;
}) {
  const hasPhotos = sortedPhotos(room.photos).length > 0;
  return (
    <div className="s-page c-article">
      <header className="c-article-head">
        <nav className="c-rubric" aria-label="Fil d'Ariane">
          <Link href="/chambres">Les chambres</Link>
          <span aria-hidden="true">·</span>
          <span>
            N°{num(index)} sur {String(total).padStart(2, "0")}
          </span>
        </nav>
        <p className="c-article-num" aria-hidden="true">
          {num(index)}
        </p>
        <h1 className="s-h1 c-article-title">
          <RoomTitle name={room.name} />
        </h1>
      </header>

      {hasPhotos && (
        <div className="c-article-gallery">
          <RoomGallery photos={room.photos} alt={room.name} />
        </div>
      )}

      <div className="c-article-body">
        <div className="c-article-text">
          {room.description && <p className="c-story-text">{room.description}</p>}
          <dl className="c-band-cols c-article-facts" data-testid="room-facts" data-count={facts.length}>
            {facts.map(([k, v]) => (
              <div key={k} className="c-band-col">
                <dt className="c-label">{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </div>
        <aside className="c-article-book s-room-detail-book">
          <div className="c-article-book-head">
            <h2 className="c-card-title">Réserver</h2>
            <RoomPrice room={{ ...room, minPrice }} />
          </div>
          {chargesNote && (
            <p className="s-hint" data-testid="room-charges-note">
              {chargesNote}
            </p>
          )}
          <RoomDates roomId={room.id} today={today} />
        </aside>
      </div>

      <div className="c-mobile-bar" data-testid="carnet-mobile-bar">
        <p>
          <span>{room.capacity} pers.</span>
          <RoomPrice room={{ ...room, minPrice }} />
        </p>
        <Link href={`/reserver/${room.id}`} className="s-btn">
          Réserver
        </Link>
      </div>

      {others.length > 0 && (
        <section className="c-also" aria-labelledby="autres-chambres">
          <div className="c-head">
            <h2 id="autres-chambres" className="s-h2">
              À lire aussi
            </h2>
          </div>
          <div className="c-also-grid">
            {others.map((r) => (
              <Link key={r.id} href={`/chambres/${r.slug}`} className="c-also-item">
                <span className="c-also-num" aria-hidden="true">
                  {num(r.index)}
                </span>
                <span className="c-also-text">
                  <span className="c-also-name">{r.name}</span>
                  {r.description && <span className="c-also-desc">{r.description}</span>}
                </span>
                <RoomPrice room={r} />
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
