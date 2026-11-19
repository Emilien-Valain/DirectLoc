/** Nom affiché du client (`bookings.guest_name`) recomposé depuis prénom et nom ; prénom facultatif. */
export function fullName(first: string | null | undefined, last: string | null | undefined): string {
  return [first?.trim(), last?.trim()].filter(Boolean).join(" ");
}

/** Inverse de `fullName`, comme la migration 0016 : premier mot = prénom, le reste = nom ; un seul mot = nom. */
export function splitName(name: string): { first: string; last: string } {
  const t = name.trim();
  const i = t.indexOf(" ");
  return i < 0 ? { first: "", last: t } : { first: t.slice(0, i), last: t.slice(i + 1).trim() };
}
