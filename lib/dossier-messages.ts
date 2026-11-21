import type { CombinationError } from "@/lib/room-combination";

/**
 * Phrases montrées au voyageur pour une répartition refusée (formulaire multi-chambres et
 * serveur : mêmes mots). Jamais le mot « Dossier » : pour le voyageur, c'est « votre réservation ».
 */

export const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

/** « 3 adultes, 1 enfant » */
export const partyLabel = (adults: number, minors: number) =>
  [plural(adults, "adulte", "adultes"), minors > 0 && plural(minors, "enfant", "enfants")].filter(Boolean).join(", ");

const pers = (n: number) => `${n} personne${n > 1 ? "s" : ""}`;

export function combinationErrorMessage(e: CombinationError, nameOf: (roomId: string) => string): string {
  const room = (id: string) => `« ${nameOf(id)} »`;
  switch (e.code) {
    case "over_capacity":
      return `${room(e.roomId)} accueille ${pers(e.capacity)} maximum.`;
    case "minors_exceed_guests":
      return `${room(e.roomId)} : plus d'enfants que de personnes.`;
    case "no_adult":
      return `${room(e.roomId)} : chaque chambre doit accueillir au moins un adulte.`;
    case "empty_room":
      return `${room(e.roomId)} n'accueille personne : retirez-la ou déplacez-y des voyageurs.`;
    case "insufficient_capacity":
      return `Ces chambres accueillent ${pers(e.capacity)}, vous êtes ${e.people} : ajoutez une chambre.`;
    case "people_mismatch":
      return e.actual < e.expected
        ? `Il reste ${pers(e.expected - e.actual)} à placer dans une chambre.`
        : `${pers(e.actual - e.expected)} de trop dans les chambres : vous êtes ${e.expected}.`;
    case "minors_mismatch":
      return `Les chambres comptent ${e.actual} enfant${e.actual > 1 ? "s" : ""}, vous en avez indiqué ${e.expected}.`;
    case "duplicate_room":
      return `${room(e.roomId)} est choisie deux fois.`;
    case "unknown_room":
    case "room_excluded":
      return `${room(e.roomId)} n'est plus disponible pour ces dates.`;
    case "empty":
      return "Choisissez au moins une chambre.";
    case "invalid_count":
    case "invalid_input":
      return "Répartition des voyageurs invalide.";
  }
}

/** Plus aucune combinaison possible : pourquoi, en mots du voyageur. */
export function noCombinationMessage(
  reason: "insufficient_capacity" | "not_enough_adults" | "invalid_input",
  people: number,
  adults: number,
  maxCapacity: number,
): string {
  if (reason === "not_enough_adults") {
    return `Chaque chambre doit accueillir au moins un adulte : avec ${adults} adulte${adults > 1 ? "s" : ""}, nos chambres libres logent ${pers(maxCapacity)} au plus. Ajoutez un adulte ou choisissez d'autres dates.`;
  }
  if (reason === "invalid_input") return "Indiquez au moins un adulte.";
  return maxCapacity > 0
    ? `Pas assez de place pour ${pers(people)} à ces dates : ${pers(maxCapacity)} au plus. Essayez d'autres dates.`
    : "Complet pour ces dates. Essayez d'autres dates.";
}
