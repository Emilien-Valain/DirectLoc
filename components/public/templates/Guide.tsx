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
  placeLine,
  roomsInWords,
  sortedPhotos,
  type PublicRoom,
} from "@/components/public/Site";
import { formatEuros } from "@/lib/utils";

/**
 * Le Guide du parc (clé en base : guide) — une brochure Unigrid de parc
 * national : barre noire, bande de la couleur de l'hôte, grille stricte,
 * filets noirs de 6 px en tête de chaque section, grotesque grasse.
 *
 * Comme le Carnet, l'accueil et l'en-tête ont leur balisage (classes g-*) ;
 * recherche, carte et chiffres clés restent ceux de Site.tsx, et les pages
 * intérieures gardent le balisage commun, habillé par templates/guide.css.
 */

const hasStory = (c: TenantConfig) => Boolean(c.storyTitle || c.storyText);

export function GuideHeader({
  name,
  config,
  showLocation,
}: {
  name: string;
  config: TenantConfig;
  showLocation: boolean;
}) {
  const eyebrow = config.heroEyebrow ?? placeLine(config);
  return (
    <div className="g-top">
      <header className="s-header g-header">
        <div className="g-brand-wrap">
          {eyebrow && <p className="g-eyebrow">{eyebrow}</p>}
          <Link href="/" className="g-brand">
            {config.logoUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={config.logoUrl} alt="" height={40} className="g-brand-logo" />
            )}
            <span className="g-brand-name">{name}</span>
          </Link>
        </div>
        <nav className="s-nav g-nav" aria-label="Navigation principale">
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
          <Link href="/#dates" className="s-nav-link g-cta">
            Réserver
          </Link>
        </nav>
        <SiteMenu showLocation={showLocation} />
      </header>
      <div className="g-band" aria-hidden="true" />
    </div>
  );
}

export function GuideHome({
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
  const photo = config.heroPhoto?.url;
  const pitch = config.heroSubtitle;
  const gallery = config.galleryPhotos ?? [];
  const price = minRoomPrice(rooms);

  return (
    <div className="g-home">
      <section className={`g-hero${photo ? " has-photo" : ""}`}>
        <div className="g-hero-main">
          {photo ? (
            <>
              <div className="g-hero-photo">
                <Image src={photo} alt="" fill priority sizes="(max-width: 1000px) 100vw, 66vw" />
              </div>
              {/* Le nom est déjà dans la barre noire : le titre n'est montré que si l'hôte l'a écrit. */}
              <h1 className={config.heroTitle ? "g-title" : "g-sr"}>{config.heroTitle ?? tenant.name}</h1>
              {pitch && <p className="g-pitch">{pitch}</p>}
            </>
          ) : (
            <div className="g-flat">
              <h1 className="g-flat-title">{config.heroTitle ?? `${roomsInWords(totalRooms)}.`}</h1>
              {pitch && <p className="g-flat-pitch">{pitch}</p>}
            </div>
          )}
        </div>
        <aside className="g-plan">
          <Search title="Planifier votre séjour" />
          {rooms.length > 0 && (
            <div className="g-plan-rooms">
              <h2 className="g-label">{totalRooms > 1 ? `Nos ${totalRooms} chambres` : "Notre chambre"}</h2>
              {rooms.map((r, i) => (
                <Link key={r.id} href={`/chambres/${r.slug}`} className="g-plan-room">
                  <span className="g-num" aria-hidden="true">
                    N°{i + 1}
                  </span>
                  <span className="g-plan-room-body">
                    <span className="g-plan-room-name">{r.name}</span>
                    <span className="g-muted">{r.capacity} pers.</span>
                  </span>
                  <RoomPrice room={r} />
                </Link>
              ))}
            </div>
          )}
        </aside>
      </section>

      <HomeStats config={config} />

      {rooms.length > 0 && (
        <section className="g-section" id="chambres" aria-labelledby="g-rooms-title">
          <div className="g-head">
            <h2 id="g-rooms-title" className="g-h2">
              {totalRooms > 1 ? "Les chambres" : "La chambre"}
            </h2>
            {totalRooms > rooms.length && (
              <Link href="/chambres" className="g-head-link">
                Voir les {totalRooms} chambres →
              </Link>
            )}
          </div>
          <div className="g-cards" data-count={Math.min(rooms.length, 3)}>
            {rooms.map((room, i) => {
              const main = sortedPhotos(room.photos)[0];
              return (
                <Link key={room.id} href={`/chambres/${room.slug}`} className="g-card">
                  {main ? (
                    <span className="g-card-photo">
                      <Image src={main.url} alt="" fill sizes="(max-width: 700px) 100vw, 33vw" />
                    </span>
                  ) : (
                    <span className="g-card-flat" aria-hidden="true">
                      {i + 1}
                    </span>
                  )}
                  <span className="g-card-head">
                    <span className="g-card-name">
                      N°{i + 1} {room.name}
                    </span>
                    <span className="g-muted">{room.capacity} pers.</span>
                  </span>
                  {room.description && <span className="g-card-desc">{room.description}</span>}
                  <span className="g-card-price">
                    <RoomPrice room={room} /> →
                  </span>
                </Link>
              );
            })}
          </div>
        </section>
      )}

      {gallery.length > 0 && (
        <section className="g-section" aria-labelledby="g-gallery-title">
          <div className="g-head">
            <h2 id="g-gallery-title" className="g-h2">
              En images
            </h2>
          </div>
          <div className="g-mosaic" data-testid="home-gallery" data-count={Math.min(gallery.length, 5)}>
            {gallery.map((p) => (
              <figure key={p.id} className="g-tile">
                <Image src={p.url} alt={p.caption ?? ""} fill sizes="(max-width: 700px) 100vw, 50vw" />
                {p.caption && <figcaption>{p.caption}</figcaption>}
              </figure>
            ))}
          </div>
        </section>
      )}

      {(hasStory(config) || showLocation) && (
        <div className={`g-house${hasStory(config) && showLocation ? " is-pair" : ""}`}>
          {hasStory(config) && (
            <section id="la-maison" className="g-story" aria-labelledby="g-story-title">
              <h2 id="g-story-title" className="g-h2">
                La maison
              </h2>
              {config.storyTitle && <p className="g-story-title">{config.storyTitle}</p>}
              {config.storyText && <p className="g-story-text">{config.storyText}</p>}
              {config.storyEyebrow && <p className="g-signature">— {config.storyEyebrow}</p>}
            </section>
          )}
          {showLocation && <HomeLocation tenant={tenant} config={config} />}
        </div>
      )}

      {price != null && (
        <div className="g-bar">
          <p className="g-bar-price">
            <span>à partir de</span>
            <strong>{formatEuros(price)} / nuit</strong>
          </p>
          <Link href="#dates" className="s-btn g-bar-btn">
            Réserver
          </Link>
        </div>
      )}
    </div>
  );
}
