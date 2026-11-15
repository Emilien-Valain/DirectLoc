/**
 * Origines de confiance Better Auth en production : BETTER_AUTH_URL + le domaine
 * de chaque tenant (et son `www.`, servi par proxy.ts comme le même tenant).
 * Les lignes sans domaine (`domain = null`) sont ignorées.
 */
export function prodTrustedOrigins(domains: (string | null)[], baseURL: string): string[] {
  return [
    new URL(baseURL).origin,
    ...domains
      .filter((d): d is string => !!d)
      .flatMap((d) => [`https://${d}`, `https://www.${d}`]),
  ];
}
