/** Petits outils de noms de lieu pour les templates publics (logique pure, testée en unitaire). */

/** Code postal trouvé dans une adresse (« 85590 »), sinon null. */
export function postcodeOf(address: string | null | undefined) {
  return (address ?? "").match(/\b(\d{5})\b/)?.[1] ?? null;
}

/** « Bons baisers des » + « Epesses » : la préposition suit l'article du lieu. */
export function greeting(place: string): [string, string] {
  const p = place.trim();
  const m = p.match(/^(les|le)\s+(.+)$/i);
  if (m) return [m[1].toLowerCase() === "les" ? "Bons baisers des" : "Bons baisers du", m[2]];
  if (/^[aeiouyhéèêàâîôû]/i.test(p)) return ["Bons baisers d’", p];
  return ["Bons baisers de", p];
}
