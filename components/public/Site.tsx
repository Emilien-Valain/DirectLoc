import Link from "next/link";
import Image from "next/image";
import type { Tenant, TenantConfig } from "@/lib/tenant-context";
import Search from "@/components/public/Search";
import HeroArt from "@/components/public/HeroArt";
import LocationMap from "@/components/public/LocationMap";
import { formatEuros } from "@/lib/utils";
import { sortedPhotos } from "@/components/public/photos";

/**
 * Sections publiques communes à tous les templates. Aucune ne montre de
 * contenu que l'hôte n'a pas renseigné : un bloc vide est masqué, jamais
 * rempli d'un texte d'exemple.
 */

export type PublicRoom = {
  id: string;
  name: string;
  slug: string;
  pricePerNight: string;
  capacity: number;
  description: string | null;
  photos: unknown;
  minPrice: number;
};

export { sortedPhotos };

/** Dernier segment de l'adresse (« 85590 Les Epesses ») : ligne de lieu honnête. */
export function placeLine(config: TenantConfig) {
  const parts = (config.address ?? "").split(/\r?\n|,/).map((s) => s.trim()).filter(Boolean);
  return parts.at(-1) ?? null;
}

export function RoomPrice({ room }: { room: PublicRoom }) {
  const base = parseFloat(room.pricePerNight);
  const from = room.minPrice < base;
  return (
    <span className="s-room-price">
      {from && <small>dès </small>}
      {formatEuros(from ? room.minPrice : base)}
      <small> / nuit</small>
    </span>
  );
}

export function RoomItem({ room, index }: { room: PublicRoom; index: number }) {
  return (
    <Link href={`/chambres/${room.slug}`} className="s-room">
      <span className="s-room-num" aria-hidden="true">
        <small>N°</small>
        {index + 1}
      </span>
      <span className="s-room-body">
        <span className="s-room-name">{room.name}</span>
        <span className="s-room-meta">
          {room.capacity} pers.
        </span>
      </span>
      <RoomPrice room={room} />
    </Link>
  );
}

export function HomeHero({
  tenant,
  config,
  rooms,
  totalRooms,
}: {
  tenant: Tenant;
  config: TenantConfig;
  rooms: PublicRoom[];
  totalRooms: number;
}) {
  const place = config.heroEyebrow ?? placeLine(config);
  const photo = config.heroPhoto?.url;

  return (
    <section className={`s-hero${photo ? " has-photo" : ""}`}>
      <div className="s-namecard">
        <h1 className="s-title">{config.heroTitle ?? tenant.name}</h1>
        {place && <p className="s-place">{place}</p>}
        {config.heroSubtitle && <p className="s-pitch">{config.heroSubtitle}</p>}
      </div>

      <HeroArt />

      {photo && (
        <div className="s-hero-photo">
          <Image src={photo} alt="" fill priority sizes={config.template === "affiche" ? "100vw" : "(max-width: 900px) 100vw, 45vw"} />
        </div>
      )}

      <Search />

      {rooms.length > 0 && (
        <div className="s-hero-rooms" id="chambres">
          <h2 className="s-h3">
            {totalRooms > 1 ? `Nos ${totalRooms} chambres` : "Notre chambre"}
          </h2>
          <div className="s-room-list">
            {rooms.map((r, i) => (
              <RoomItem key={r.id} room={r} index={i} />
            ))}
          </div>
          {totalRooms > rooms.length && (
            <Link href="/chambres" className="s-link">
              Voir toutes les chambres
            </Link>
          )}
        </div>
      )}
    </section>
  );
}

export function HomeStory({ config }: { config: TenantConfig }) {
  const { storyTitle, storyText, storyEyebrow } = config;
  if (!storyTitle && !storyText) return null;
  return (
    <section className="s-section s-story">
      <div className="s-story-inner">
        {storyTitle && <h2 className="s-h2">{storyTitle}</h2>}
        {storyText && <p className="s-prose">{storyText}</p>}
        {storyEyebrow && <p className="s-signature">{storyEyebrow}</p>}
      </div>
    </section>
  );
}

export function HomeStats({ config }: { config: TenantConfig }) {
  const stats = config.storyStats ?? [];
  if (stats.length === 0) return null;
  return (
    <section id="chiffres-cles" className="s-section s-stats">
      <h2 className="s-h2">{config.keyStatsTitle ?? "La maison en bref"}</h2>
      <dl className="s-stat-list">
        {stats.map((s, i) => (
          <div key={`${s.label}-${i}`} className="s-stat">
            <dd className="s-stat-value">{s.value}</dd>
            <dt className="s-stat-label">{s.label}</dt>
            {s.sub && <dd className="s-stat-sub">{s.sub}</dd>}
          </div>
        ))}
      </dl>
    </section>
  );
}

export function HomeGallery({ config }: { config: TenantConfig }) {
  const photos = config.galleryPhotos ?? [];
  if (photos.length === 0) return null;
  return (
    <section className="s-section s-gallery" aria-label="Photos de la maison">
      <div className="s-gallery-grid" data-testid="home-gallery" data-count={photos.length}>
        {photos.map((p) => (
          <figure key={p.id} className="s-gallery-item">
            <div className="s-gallery-img">
              <Image src={p.url} alt={p.caption ?? ""} fill sizes="(max-width: 700px) 100vw, 33vw" />
            </div>
            {p.caption && <figcaption>{p.caption}</figcaption>}
          </figure>
        ))}
      </div>
    </section>
  );
}

export function HomeLocation({ tenant, config }: { tenant: Tenant; config: TenantConfig }) {
  const hasCoords = config.latitude != null && config.longitude != null;
  const mapsUrl =
    config.googleMapsUrl ??
    (hasCoords
      ? `https://www.google.com/maps/search/?api=1&query=${config.latitude},${config.longitude}`
      : null);
  const addressLines = (config.address ?? "").split(/\r?\n|,/).map((s) => s.trim()).filter(Boolean);
  const hours = [
    config.checkInTime && `Arrivée : ${config.checkInTime}`,
    config.checkOutTime && `Départ : ${config.checkOutTime}`,
  ].filter(Boolean) as string[];
  const access = config.accessLines ?? [];

  return (
    <section id="nous-trouver" className="s-section s-location">
      <div className="s-location-text">
        <h2 className="s-h2">Nous trouver</h2>
        {config.locationTitle && <p className="s-lead">{config.locationTitle}</p>}
        {config.locationSubtitle && <p className="s-prose">{config.locationSubtitle}</p>}

        <dl className="s-facts">
          {addressLines.length > 0 && (
            <div className="s-fact">
              <dt>Adresse</dt>
              <dd>
                <span className="s-fact-strong">{tenant.name}</span>
                {addressLines.map((l, i) => (
                  <span key={i}>{l}</span>
                ))}
              </dd>
            </div>
          )}
          {(config.phone || config.email) && (
            <div className="s-fact">
              <dt>Contact</dt>
              <dd>
                {config.phone && <a href={`tel:${config.phone}`}>{config.phone}</a>}
                {config.email && <a href={`mailto:${config.email}`}>{config.email}</a>}
              </dd>
            </div>
          )}
          {hours.length > 0 && (
            <div className="s-fact">
              <dt>Horaires</dt>
              <dd>
                {hours.map((h) => (
                  <span key={h}>{h}</span>
                ))}
              </dd>
            </div>
          )}
          {access.length > 0 && (
            <div className="s-fact">
              <dt>Accès</dt>
              <dd>
                {access.map((a, i) => (
                  <span key={i}>{a}</span>
                ))}
              </dd>
            </div>
          )}
        </dl>
      </div>

      {(hasCoords || mapsUrl) && (
        <div className="s-map">
          {hasCoords && (
            <LocationMap latitude={config.latitude!} longitude={config.longitude!} label={tenant.name} />
          )}
          {mapsUrl && (
            <a href={mapsUrl} target="_blank" rel="noopener noreferrer" className="s-map-link">
              Ouvrir dans Google Maps
            </a>
          )}
        </div>
      )}
    </section>
  );
}

export function Breadcrumb({ items }: { items: { href?: string; label: string }[] }) {
  return (
    <nav className="s-crumbs" aria-label="Fil d'Ariane">
      <ol>
        {items.map((it, i) => (
          <li key={i}>
            {it.href ? <Link href={it.href}>{it.label}</Link> : <span aria-current="page">{it.label}</span>}
          </li>
        ))}
      </ol>
    </nav>
  );
}
