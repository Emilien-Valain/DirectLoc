/**
 * Réseau des Voisins (ADR-0013) — partie PURE : appartenance, distance, tri. Aucun accès DB.
 * La lecture entre tenants elle-même est dans `lib/network.ts`.
 */
import type { TenantConfig } from "@/lib/tenant-context";

/** Rayon moyen de la Terre (km). */
const EARTH_RADIUS_KM = 6371.0088;

/** Distance à vol d'oiseau (grand cercle) entre deux points GPS, en km. */
export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Position GPS exploitable de la config, sinon null. */
export function gpsOf(config: TenantConfig | null | undefined): { lat: number; lng: number } | null {
  const lat = config?.latitude;
  const lng = config?.longitude;
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

/** Membre du réseau : GPS présent et `networkEnabled` pas à false (absent = activé). */
export function isNetworkMember(config: TenantConfig | null | undefined): boolean {
  return config?.networkEnabled !== false && gpsOf(config) !== null;
}

export interface NetworkTenantRow {
  id: string;
  slug: string;
  name: string;
  domain: string | null;
  config: TenantConfig | null;
}

export interface NearbyTenant {
  row: NetworkTenantRow;
  /** km à vol d'oiseau, arrondi à 0,1. */
  distanceKm: number;
}

/**
 * Voisins possibles de `origin` : membres du réseau avec GPS et domaine actif, origine exclue,
 * triés du plus proche au plus lointain (égalité : slug). Origine hors réseau → liste vide
 * (le réseau est réciproque).
 */
export function selectNearbyTenants(origin: NetworkTenantRow, all: NetworkTenantRow[]): NearbyTenant[] {
  const from = isNetworkMember(origin.config) ? gpsOf(origin.config) : null;
  if (!from) return [];
  return all
    .filter((t) => t.id !== origin.id && !!t.domain && isNetworkMember(t.config))
    .map((row) => ({ row, distanceKm: Math.round(haversineKm(from, gpsOf(row.config)!) * 10) / 10 }))
    .sort((a, b) => a.distanceKm - b.distanceKm || (a.row.slug < b.row.slug ? -1 : 1));
}

// ── Partage d'un groupe entre l'hôte et un Voisin (pur) ─────────────────────

/** Plafond d'un groupe (même valeur que `MAX_PARTY` de validation.ts, sans l'importer ici). */
const SHARE_MAX_PARTY = 50;

/** Ce que l'URL transporte du partage : le Voisin proposé et les personnes qu'il doit loger. */
export interface ShareParam {
  slug: string;
  adults: number;
  minors: number;
}

/** `share=<slug>:<adultes>:<mineurs>` → valeurs validées, ou null (forme, plafonds, ≥ 1 adulte). */
export function parseShare(raw: unknown): ShareParam | null {
  if (typeof raw !== "string") return null;
  const m = /^([a-z0-9-]{1,63}):(\d{1,2}):(\d{1,2})$/.exec(raw);
  if (!m) return null;
  const adults = Number(m[2]);
  const minors = Number(m[3]);
  if (adults < 1 || adults + minors > SHARE_MAX_PARTY) return null;
  return { slug: m[1], adults, minors };
}

export const formatShare = (s: ShareParam) => `${s.slug}:${s.adults}:${s.minors}`;

export interface SharePlan {
  host: { adults: number; minors: number };
  rest: { adults: number; minors: number };
}

/**
 * Répartition d'un groupe entre l'hôte et UN Voisin. L'hôte en loge le plus possible (au plus
 * `hostMax`, jamais tout le groupe) ; chaque côté garde au moins 1 adulte, les mineurs vont
 * d'abord chez le Voisin. `fitsHost` / `fitsVoisin` sont les dry runs du moteur de combinaison.
 * Null si aucune répartition ne passe des deux côtés.
 */
export function planShare(
  adults: number,
  minors: number,
  hostMax: number,
  fitsHost: (adults: number, minors: number) => boolean,
  fitsVoisin: (adults: number, minors: number) => boolean,
): SharePlan | null {
  const people = adults + minors;
  for (let n = Math.min(hostMax, people - 1); n >= 1; n--) {
    const m = people - n;
    for (let mv = Math.min(minors, m - 1); mv >= 0; mv--) {
      const av = m - mv;
      const ah = adults - av;
      if (ah < 1 || av < 1 || minors - mv < 0) continue;
      if (fitsHost(ah, minors - mv) && fitsVoisin(av, mv)) return { host: { adults: ah, minors: minors - mv }, rest: { adults: av, minors: mv } };
    }
  }
  return null;
}
