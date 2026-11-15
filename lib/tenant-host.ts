/** Domaine apex d'un host prod : `www.hotelducoin.fr` → `hotelducoin.fr` (insensible à la casse). */
export function apexHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, "");
}
