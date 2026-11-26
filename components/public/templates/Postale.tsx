import Link from "next/link";
import Image from "next/image";
import type { Tenant, TenantConfig } from "@/lib/tenant-context";
import Search from "@/components/public/Search";
import SiteMenu from "@/components/public/SiteMenu";
import LocationMap from "@/components/public/LocationMap";
import {
  HomeStats,
  RoomPrice,
  minRoomPrice,
  postcode,
  roomsInWords,
  sortedPhotos,
  townName,
  type PublicRoom,
} from "@/components/public/Site";
import { formatEuros } from "@/lib/utils";
import { greeting } from "@/lib/place";

/**
 * La Carte postale (clé en base : postale) — « Greetings from » : grandes
 * lettres rayées aux couleurs de l'hôte, tampons, chambres en cartes qui
 * flottent, la lettre des hôtes en dos de carte.
 *
 * Accueil et en-tête ont leur balisage (classes p-*) ; recherche et chiffres
 * clés restent ceux de Site.tsx, et les pages intérieures gardent le balisage
 * commun, habillé par templates/postale.css.
 */

const hasStory = (c: TenantConfig) => Boolean(c.storyTitle || c.storyText);

/** Rotations des cartes et timbres : légères, alternées, stables d'un rendu à l'autre. */
const TILT = [-4, 2.5, -1.5, 3];

export function PostaleHeader({
  name,
  config,
  showLocation,
}: {
  name: string;
  config: TenantConfig;
  showLocation: boolean;
}) {
  return (
    <header className="s-header p-header">
      <Link href="/" className="p-brand">
        {config.logoUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={config.logoUrl} alt="" height={36} className="p-brand-logo" />
        )}
        <span>{name}</span>
      </Link>
      <nav className="s-nav p-nav" aria-label="Navigation principale">
        <Link href="/chambres" className="s-nav-link">
          Chambres
        </Link>
        {hasStory(config) && (
          <Link href="/#la-maison" className="s-nav-link">
            La maison
          </Link>
        )}
        {showLocation && (
          <Link href="/#nous-trouver" className="s-nav-link">
            Nous trouver
          </Link>
        )}
        <Link href="/#dates" className="s-nav-link s-nav-cta">
          Réserver
        </Link>
      </nav>
      <SiteMenu showLocation={showLocation} />
    </header>
  );
}

export function PostaleHome({
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
  const town = townName(config);
  const pc = postcode(config);
  const [greet, word] = greeting(town ?? tenant.name);
  const pitch = config.heroSubtitle;
  const gallery = config.galleryPhotos ?? [];
  const price = minRoomPrice(rooms);

  const hasCoords = config.latitude != null && config.longitude != null;
  const mapsUrl =
    config.googleMapsUrl ??
    (hasCoords ? `https://www.google.com/maps/search/?api=1&query=${config.latitude},${config.longitude}` : null);
  const addressLines = (config.address ?? "").split(/\r?\n|,/).map((s) => s.trim()).filter(Boolean);
  const hours = [
    config.checkInTime && `Arrivée ${config.checkInTime}`,
    config.checkOutTime && `Départ ${config.checkOutTime}`,
  ].filter(Boolean);
  const access = config.accessLines ?? [];

  return (
    <div className="p-home">
      <section className="p-hero">
        <h1 className="p-title">
          <span className="p-greet">{greet}</span>
          {greet.endsWith("’") ? "" : " "}
          <span className="p-letters" data-size={word.length > 14 ? "s" : word.length > 8 ? "m" : undefined}>
            {word}
          </span>
        </h1>
        {pc && (
          <span className="p-stamp" aria-hidden="true">
            {town && <span>{town}</span>}
            <span className="p-stamp-num">{pc}</span>
          </span>
        )}
        <span className="p-badge" aria-hidden="true">
          ✱ DIRECT ✱
        </span>
        {pitch && <p className="p-pitch">{pitch}</p>}
        <div className="p-search">
          <Search title="Écrivez-nous vos dates…" submitLabel="Envoyer la carte →" />
        </div>
      </section>

      {rooms.length > 0 && (
        <section id="chambres" className="p-section" aria-labelledby="p-rooms-title">
          <h2 id="p-rooms-title" className="p-h2">
            {totalRooms > 1
              ? `${roomsInWords(totalRooms)}, ${roomsInWords(totalRooms).split(" ")[0].toLowerCase()} cartes`
              : "Une chambre, une carte"}
          </h2>
          <div className="p-cards">
            {rooms.map((room, i) => {
              const main = sortedPhotos(room.photos)[0];
              return (
                <Link
                  key={room.id}
                  href={`/chambres/${room.slug}`}
                  className="p-card"
                  style={{ "--r": `${TILT[i % TILT.length]}deg`, "--delay": `${-1.6 * i}s` } as React.CSSProperties}
                >
                  {main ? (
                    <span className="p-card-photo">
                      <Image src={main.url} alt="" fill sizes="(max-width: 700px) 100vw, 340px" />
                    </span>
                  ) : (
                    <span className="p-card-flat" aria-hidden="true">
                      {i + 1}
                    </span>
                  )}
                  <span className="p-card-head">
                    <span className="p-card-name">{room.name}</span>
                    <span className="p-card-num">N°{i + 1}</span>
                  </span>
                  {room.description && <span className="p-card-desc">{room.description}</span>}
                  <span className="p-card-foot">
                    <span>{room.capacity} pers.</span>
                    <RoomPrice room={room} />
                  </span>
                </Link>
              );
            })}
          </div>
          {totalRooms > rooms.length && (
            <Link href="/chambres" className="p-link">
              Les {totalRooms} cartes →
            </Link>
          )}
        </section>
      )}

      <HomeStats config={config} />

      {gallery.length > 0 && (
        <section className="p-section" aria-labelledby="p-gallery-title">
          <h2 id="p-gallery-title" className="p-h2">
            Quelques souvenirs
          </h2>
          <div className="p-polaroids" data-testid="home-gallery">
            {gallery.map((p, i) => (
              <figure key={p.id} className="p-polaroid" style={{ "--r": `${TILT[(i + 1) % TILT.length]}deg` } as React.CSSProperties}>
                <span className="p-polaroid-img">
                  <Image src={p.url} alt={p.caption ?? ""} fill sizes="(max-width: 700px) 80vw, 280px" />
                </span>
                {p.caption && <figcaption>{p.caption}</figcaption>}
              </figure>
            ))}
          </div>
        </section>
      )}

      {(hasStory(config) || showLocation) && (
        <section className={`p-letter${hasStory(config) && showLocation ? " is-pair" : ""}`} aria-label="La lettre des hôtes">
          {hasStory(config) && (
            <div id="la-maison" className="p-letter-msg">
              <h2 className="p-label">La maison</h2>
              {config.storyTitle && <p className="p-letter-title">{config.storyTitle}</p>}
              {config.storyText && <p className="p-letter-text">{config.storyText}</p>}
              {config.storyEyebrow && <p className="p-signature">{config.storyEyebrow}</p>}
            </div>
          )}
          {showLocation && (
            <div id="nous-trouver" className="p-letter-addr">
              <div className="p-addr-head">
                <h2 className="p-label">Nous trouver</h2>
                {pc && (
                  <span className="p-addr-stamp" aria-hidden="true">
                    {pc.slice(0, 2)}
                  </span>
                )}
              </div>
              {addressLines.length > 0 && (
                <address className="p-lines">
                  <span>{tenant.name}</span>
                  {addressLines.map((l, i) => (
                    <span key={i}>{l}</span>
                  ))}
                </address>
              )}
              {(config.phone || config.email) && (
                <p className="p-lines">
                  {config.phone && <a href={`tel:${config.phone}`}>{config.phone}</a>}
                  {config.email && <a href={`mailto:${config.email}`}>{config.email}</a>}
                </p>
              )}
              {hours.length > 0 && <p className="p-hours">{hours.join(" · ")}</p>}
            </div>
          )}
        </section>
      )}

      {showLocation && (hasCoords || mapsUrl || access.length > 0) && (
        <section className={`p-plan${(hasCoords || mapsUrl) && access.length > 0 ? " is-pair" : ""}`} aria-label="Plan et accès">
          {(hasCoords || mapsUrl) && (
            <div className="s-map p-map">
              {hasCoords && <LocationMap latitude={config.latitude!} longitude={config.longitude!} label={tenant.name} />}
              {mapsUrl && (
                <a href={mapsUrl} target="_blank" rel="noopener noreferrer" className="s-map-link">
                  Itinéraire
                </a>
              )}
            </div>
          )}
          {access.length > 0 && (
            <ul className="p-access">
              {access.map((a, i) => (
                <li key={i}>{a}</li>
              ))}
            </ul>
          )}
        </section>
      )}

      {price != null && (
        <div className="p-bar">
          <p className="p-bar-price">
            <span>à partir de</span>
            <strong>{formatEuros(price)} / nuit</strong>
          </p>
          <Link href="#dates" className="p-bar-btn">
            Réserver
          </Link>
        </div>
      )}
    </div>
  );
}
