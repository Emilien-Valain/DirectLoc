import Link from "next/link";
import type { TenantConfig } from "@/lib/tenant-context";
import { formatEuros } from "@/lib/utils";
import PendingRefresh from "@/components/public/PendingRefresh";

/** « À samedi » si l'arrivée est dans la semaine, sinon « À samedi 12 décembre ». */
function soonLabel(checkIn: Date) {
  const days = (checkIn.getTime() - Date.now()) / 86_400_000;
  const opts: Intl.DateTimeFormatOptions =
    days >= 0 && days < 6 ? { weekday: "long", timeZone: "UTC" } : { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" };
  return `À ${checkIn.toLocaleDateString("fr-FR", opts)}`;
}

const formatDate = (d: Date) =>
  d.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });

export default function Confirmation({
  isPaid,
  guestName,
  guestFirstName,
  guestEmail,
  rooms,
  checkIn,
  checkOut,
  nights,
  totalPrice,
  reference,
  config,
  share,
}: {
  isPaid: boolean;
  guestName: string;
  /** Prénom seul : titre personnel du Carnet (« À samedi, Claire. »). */
  guestFirstName?: string;
  guestEmail: string;
  /** Chambres de la réservation (une seule : affichage historique, ligne « Chambre »). */
  rooms: { name: string | null; guests: number; total: string; extras: { label: string; total: number }[] }[];
  checkIn: Date;
  checkOut: Date;
  nights: number;
  totalPrice: string;
  reference: string;
  config: TenantConfig;
  /** Partage de groupe : reste du groupe à loger ailleurs (Voisin revérifié, sinon téléphone de l'hôte). */
  share?: {
    guests: number;
    other: boolean;
    voisin: { name: string; city: string | null; distanceKm: number; href: string } | null;
  };
}) {
  const single = rooms.length === 1;
  const lines = (r: (typeof rooms)[number], indent = "") =>
    r.extras.map((x): [string, string] => [indent + x.label, x.total === 0 ? "Offert" : formatEuros(x.total)]);
  const rows: [string, string][] = [
    ...(single ? [["Chambre", rooms[0].name ?? "—"] as [string, string]] : []),
    ["Arrivée", formatDate(checkIn) + (config.checkInTime ? `, ${config.checkInTime}` : "")],
    ["Départ", formatDate(checkOut) + (config.checkOutTime ? `, ${config.checkOutTime}` : "")],
    ["Durée", `${nights} nuit${nights > 1 ? "s" : ""}`],
    ...(single
      ? lines(rooms[0])
      : rooms.flatMap((r): [string, string][] => [
          [`${r.name ?? "Chambre"} · ${r.guests} pers.`, formatEuros(r.total)],
          ...lines(r, "— "),
        ])),
    ["Total", formatEuros(totalPrice)],
  ];

  // Itinéraire : lien Maps saisi par l'hôte, sinon coordonnées, sinon adresse.
  const destination =
    config.latitude != null && config.longitude != null
      ? `${config.latitude},${config.longitude}`
      : config.address;
  const mapsUrl =
    config.googleMapsUrl ??
    (destination ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}` : null);
  const hasArrival = isPaid && (config.address || mapsUrl || config.phone || config.email);

  // ph-no-capture : exclu du replay PostHog (données de réservation).
  return (
    <section className="s-page s-confirm ph-no-capture">
      <div className="s-confirm-card">
        <p className={`s-status ${isPaid ? "is-good" : "is-warn"}`}>
          {isPaid ? "Réservation confirmée" : "Paiement en cours de vérification"}
        </p>
        {isPaid && config.template === "carnet" ? (
          <h1 className="s-h1 c-confirm-title">
            {soonLabel(checkIn)}, <em>{guestFirstName?.trim() || guestName}.</em>
          </h1>
        ) : (
          <h1 className="s-h1">{isPaid ? `Merci, ${guestName} !` : "Encore un instant"}</h1>
        )}
        {isPaid ? (
          <p className="s-prose">
            {single ? "Votre séjour est réservé" : `Vos ${rooms.length} chambres sont réservées`}. La confirmation vient
            d&apos;être envoyée à <strong>{guestEmail}</strong>.
          </p>
        ) : (
          <PendingRefresh guestEmail={guestEmail} phone={config.phone} />
        )}
        <p className="s-ref">
          Référence <strong>{reference}</strong>
        </p>
        <dl className="s-rows">
          {rows.map(([k, v], i) => (
            <div key={i} className="s-row">
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        {share && (
          <div className="s-share" data-testid="share-followup">
            <h2 className="s-h3">Et le reste de votre groupe ?</h2>
            {share.voisin ? (
              <>
                <p className="s-prose">
                  {share.other ? "Un autre hébergement voisin" : "Notre voisin"} <strong>{share.voisin.name}</strong>
                  {share.voisin.city ? ` (${share.voisin.city})` : ""}, à {share.voisin.distanceKm.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} km, peut loger
                  les {share.guests} autres personnes. Vous réservez chez lui séparément : 2 réservations et 2 paiements séparés.
                </p>
                <a href={share.voisin.href} className="s-btn" data-testid="share-voisin-link">
                  Loger les {share.guests} autres chez {share.voisin.name}
                </a>
              </>
            ) : (
              <p className="s-prose" data-testid="share-phone">
                Nous n&apos;avons plus de voisin disponible pour les {share.guests} autres personnes aux mêmes dates.{" "}
                {config.phone ? (
                  <>
                    Appelez-nous, nous chercherons avec vous : <a href={`tel:${config.phone}`}>{config.phone}</a>.
                  </>
                ) : (
                  "Contactez-nous, nous chercherons avec vous."
                )}
              </p>
            )}
          </div>
        )}
        {config.confirmationMessage && <p className="s-prose s-host-note">{config.confirmationMessage}</p>}
        {hasArrival && (
          <div className="s-arrival" data-testid="confirmation-arrival">
            <h2 className="s-h3">Préparer votre arrivée</h2>
            {config.address && <p className="s-prose">{config.address}</p>}
            <p className="s-arrival-links">
              {config.phone && <a href={`tel:${config.phone}`}>{config.phone}</a>}
              {config.email && <a href={`mailto:${config.email}`}>{config.email}</a>}
            </p>
            {mapsUrl && (
              <a href={mapsUrl} className="s-btn" target="_blank" rel="noopener noreferrer">
                Voir l&apos;itinéraire
              </a>
            )}
          </div>
        )}
        <Link href="/" className={hasArrival && mapsUrl ? "s-link" : "s-btn"}>
          Retour à l&apos;accueil
        </Link>
      </div>
    </section>
  );
}
