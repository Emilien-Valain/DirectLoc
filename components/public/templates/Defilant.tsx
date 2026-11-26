import Link from "next/link";
import Image from "next/image";
import type { Tenant, TenantConfig } from "@/lib/tenant-context";
import Search from "@/components/public/Search";
import SiteMenu from "@/components/public/SiteMenu";
import {
  HomeLocation,
  HomeStats,
  RoomPrice,
  minRoomPrice,
  roomsInWords,
  sortedPhotos,
  townName,
  type PublicRoom,
} from "@/components/public/Site";
import { formatEuros } from "@/lib/utils";
import Ticker from "@/components/public/templates/DefilantTicker";

/**
 * Le Défilant (clé en base : defilant) — typo cinétique d'agence : la page
 * entière prend la couleur de l'hôte, le nom défile en lettres géantes, un
 * jaune néon fixe signale chaque action, les chambres sont des lignes géantes
 * qui s'ouvrent au survol.
 *
 * Accueil, en-tête et bandeau de pied ont leur balisage (classes d-*) ;
 * recherche, carte et chiffres clés restent ceux de Site.tsx, et les pages
 * intérieures gardent le balisage commun, posé sur la « feuille » claire par
 * templates/defilant.css.
 */

const hasStory = (c: TenantConfig) => Boolean(c.storyTitle || c.storyText);

export function DefilantHeader({
  name,
  config,
  showLocation,
}: {
  name: string;
  config: TenantConfig;
  showLocation: boolean;
}) {
  return (
    <header className="s-header d-header">
      <Link href="/" className="d-brand">
        {config.logoUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={config.logoUrl} alt="" height={36} className="d-brand-logo" />
        )}
        <span>{name}</span>
      </Link>
      <nav className="s-nav d-nav" aria-label="Navigation principale">
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

/** Bandeau de pied, en sens inverse : infos pratiques que l'hôte a renseignées. */
export function DefilantFooterTicker({ config }: { config: TenantConfig }) {
  const items = [
    "Réservation directe",
    config.checkInTime && `Arrivée ${config.checkInTime}`,
    config.checkOutTime && `Départ ${config.checkOutTime}`,
    ...(config.accessLines ?? []),
  ].filter(Boolean);
  return <Ticker text={`${items.join(" ✱ ")} ✱`} className="d-ticker-foot" />;
}

export function DefilantHome({
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
  const pitch = config.heroSubtitle;
  const gallery = config.galleryPhotos ?? [];
  const price = minRoomPrice(rooms);

  return (
    <div className="d-home">
      <h1 className="s-sr-only">
        {config.heroTitle ?? tenant.name}
        {town && `, ${town}`}
      </h1>
      <Ticker text={[tenant.name, town].filter(Boolean).join(" ✱ ") + " ✱"} className="d-ticker-hero" />

      <section className="d-hero">
        {pitch && <p className="d-pitch">{pitch}</p>}
        <div className="d-search">
          <Search title="Vos dates" submitLabel="C'est parti →" />
        </div>
      </section>

      <div className="d-sheet">
        {rooms.length > 0 && (
          <section id="chambres" className="d-rooms" aria-labelledby="d-rooms-title">
            <div className="d-label-row">
              <h2 id="d-rooms-title" className="d-label">
                {totalRooms > 1 ? "Les chambres" : "La chambre"}
              </h2>
              <span className="d-muted">{roomsInWords(totalRooms)}</span>
            </div>
            {rooms.map((room, i) => {
              const main = sortedPhotos(room.photos)[0];
              return (
                <Link key={room.id} href={`/chambres/${room.slug}`} className="d-row">
                  <span className="d-row-num" aria-hidden="true">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  {main && (
                    <span className="d-row-photo">
                      <Image src={main.url} alt="" fill sizes="(max-width: 700px) 100vw, 240px" />
                    </span>
                  )}
                  <span className="d-row-body">
                    <span className="d-row-name" data-long={room.name.length > 16 || undefined}>
                      {room.name}
                    </span>
                    {room.description && <span className="d-row-desc">{room.description}</span>}
                  </span>
                  <span className="d-row-side">
                    <RoomPrice room={room} />
                    <span className="d-muted">{room.capacity} pers.</span>
                  </span>
                </Link>
              );
            })}
            {totalRooms > rooms.length && (
              <Link href="/chambres" className="d-pill-link">
                Les {totalRooms} chambres →
              </Link>
            )}
          </section>
        )}

        <HomeStats config={config} />

        {gallery.length > 0 && (
          <section className="d-gallery" aria-labelledby="d-gallery-title">
            <h2 id="d-gallery-title" className="d-h2">
              En images
            </h2>
            <div className="d-strip" data-testid="home-gallery" data-count={Math.min(gallery.length, 4)}>
              {gallery.map((p) => (
                <figure key={p.id} className="d-tile">
                  <Image src={p.url} alt={p.caption ?? ""} fill sizes="(max-width: 700px) 100vw, 40vw" />
                  {p.caption && <figcaption>{p.caption}</figcaption>}
                </figure>
              ))}
            </div>
          </section>
        )}

        {(hasStory(config) || showLocation) && (
          <div className={`d-house${hasStory(config) && showLocation ? " is-pair" : ""}`}>
            {hasStory(config) && (
              <section id="la-maison" className="d-story" aria-labelledby="d-story-title">
                <h2 id="d-story-title" className="d-label">
                  La maison
                </h2>
                {config.storyTitle && <p className="d-story-title">{config.storyTitle}</p>}
                {config.storyText && (
                  <p className="d-quote">
                    <span className="d-story-text">{config.storyText}</span>
                    {config.storyEyebrow && <span className="d-signature"> — {config.storyEyebrow}</span>}
                  </p>
                )}
                {!config.storyText && config.storyEyebrow && <p className="d-signature">— {config.storyEyebrow}</p>}
              </section>
            )}
            {showLocation && <HomeLocation tenant={tenant} config={config} />}
          </div>
        )}
        {price != null && (
          <div className="d-bar">
            <p className="d-bar-price">
              <span>à partir de</span>
              <strong>{formatEuros(price)} / nuit</strong>
            </p>
            <Link href="#dates" className="d-bar-btn">
              Réserver →
            </Link>
          </div>
        )}
      </div>

    </div>
  );
}
