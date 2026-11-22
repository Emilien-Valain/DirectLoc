import { test, expect } from "@playwright/test";
import { formatShare, haversineKm, isNetworkMember, parseShare, planShare, selectNearbyTenants, type NetworkTenantRow } from "../../lib/network-geo";

const row = (slug: string, config: NetworkTenantRow["config"], domain: string | null = `${slug}.example.com`): NetworkTenantRow => ({
  id: `id-${slug}`,
  slug,
  name: slug.toUpperCase(),
  domain,
  config,
});
// ~ Les Épesses (85) et alentours : 0,1° de latitude ≈ 11,1 km.
const at = (dLat: number, extra: NetworkTenantRow["config"] = {}) => ({ latitude: 46.9 + dLat, longitude: -0.9, ...extra });

test.describe("réseau des Voisins — logique pure", () => {
  test("haversine : zéro, symétrie, valeur connue (Paris–Lyon ≈ 392 km)", () => {
    const paris = { lat: 48.8566, lng: 2.3522 };
    const lyon = { lat: 45.764, lng: 4.8357 };
    expect(haversineKm(paris, paris)).toBe(0);
    expect(haversineKm(paris, lyon)).toBeCloseTo(haversineKm(lyon, paris), 9);
    expect(haversineKm(paris, lyon)).toBeGreaterThan(388);
    expect(haversineKm(paris, lyon)).toBeLessThan(396);
    // antiméridien : pas de saut de 360°
    expect(haversineKm({ lat: 0, lng: 179.9 }, { lat: 0, lng: -179.9 })).toBeLessThan(25);
  });

  test("appartenance : GPS requis, networkEnabled absent = activé, false = sorti", () => {
    expect(isNetworkMember(at(0))).toBe(true);
    expect(isNetworkMember(at(0, { networkEnabled: true }))).toBe(true);
    expect(isNetworkMember(at(0, { networkEnabled: false }))).toBe(false);
    expect(isNetworkMember({})).toBe(false);
    expect(isNetworkMember(null)).toBe(false);
    expect(isNetworkMember({ latitude: 46.9 })).toBe(false);
    expect(isNetworkMember({ latitude: 91, longitude: 0 })).toBe(false);
    expect(isNetworkMember({ latitude: Number.NaN, longitude: 0 })).toBe(false);
  });

  test("tri par distance croissante, origine exclue, distance arrondie à 0,1 km", () => {
    const origin = row("origin", at(0));
    const out = selectNearbyTenants(origin, [row("far", at(0.5)), origin, row("near", at(0.1)), row("mid", at(0.3))]);
    expect(out.map((o) => o.row.slug)).toEqual(["near", "mid", "far"]);
    expect(out[0].distanceKm).toBeGreaterThan(10.5);
    expect(out[0].distanceKm).toBeLessThan(11.7);
    expect(Math.round(out[0].distanceKm * 10)).toBe(out[0].distanceKm * 10);
  });

  test("égalité de distance : départage stable par slug", () => {
    const origin = row("origin", at(0));
    const out = selectNearbyTenants(origin, [row("zeta", at(0.1)), row("alpha", at(0.1))]);
    expect(out.map((o) => o.row.slug)).toEqual(["alpha", "zeta"]);
  });

  test("exclusions : sans GPS, désactivé, sans domaine", () => {
    const origin = row("origin", at(0));
    const out = selectNearbyTenants(origin, [
      row("ok", at(0.1)),
      row("nogps", {}),
      row("off", at(0.1, { networkEnabled: false })),
      row("nodomain", at(0.1), null),
      row("emptydomain", at(0.1), ""),
    ]);
    expect(out.map((o) => o.row.slug)).toEqual(["ok"]);
  });

  test("origine hors réseau (sans GPS ou désactivée) : aucun Voisin (réciprocité)", () => {
    const all = [row("ok", at(0.1))];
    expect(selectNearbyTenants(row("o1", {}), all)).toEqual([]);
    expect(selectNearbyTenants(row("o2", at(0, { networkEnabled: false })), all)).toEqual([]);
    expect(selectNearbyTenants(row("o3", null), all)).toEqual([]);
  });

  test("share : parseShare n'accepte que slug:adultes:mineurs bornés, jamais d'injection", () => {
    expect(parseShare("gites-du-bocage:4:0")).toEqual({ slug: "gites-du-bocage", adults: 4, minors: 0 });
    expect(parseShare(formatShare({ slug: "a", adults: 2, minors: 3 }))).toEqual({ slug: "a", adults: 2, minors: 3 });
    for (const bad of [undefined, null, 5, "", "a", "a:1", "a:0:2", "a:1:-1", "a:x:1", "A:1:1", "a:1:1:1", "a b:1:1", "a:30:30", "a:100:0", "<script>:1:1", "a:1:1\n"]) {
      expect(parseShare(bad), String(bad)).toBeNull();
    }
  });

  test("share : planShare — l'hôte en loge le plus possible, le Voisin le reste, 1 adulte de chaque côté", () => {
    const cap = (n: number) => (a: number, m: number) => a >= 1 && a + m <= n;
    // 9 adultes : l'hôte 5, le Voisin 4
    expect(planShare(9, 0, 5, cap(5), cap(4))).toEqual({ host: { adults: 5, minors: 0 }, rest: { adults: 4, minors: 0 } });
    // 6 adultes + 3 mineurs : les mineurs partent chez le Voisin
    expect(planShare(6, 3, 5, cap(5), cap(4))).toEqual({ host: { adults: 5, minors: 0 }, rest: { adults: 1, minors: 3 } });
    // le Voisin ne peut pas loger le reste → null
    expect(planShare(9, 0, 5, cap(5), cap(3))).toBeNull();
    // l'hôte n'a rien → null
    expect(planShare(4, 0, 0, cap(0), cap(9))).toBeNull();
    // jamais tout le groupe chez l'hôte (hostMax ≥ groupe) : le reste est ≥ 1
    expect(planShare(3, 0, 9, cap(9), cap(9))?.rest.adults).toBeGreaterThanOrEqual(1);
    // un seul adulte : impossible de partager (1 adulte de chaque côté)
    expect(planShare(1, 5, 3, cap(3), cap(9))).toBeNull();
    // si l'hôte ne passe pas avec N max, N diminue
    const hostOnly3 = (a: number, m: number) => a + m <= 3 && a >= 1;
    expect(planShare(6, 0, 5, hostOnly3, cap(6))).toEqual({ host: { adults: 3, minors: 0 }, rest: { adults: 3, minors: 0 } });
  });
});
