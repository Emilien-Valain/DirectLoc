/**
 * Variables des messages personnalisés des emails (confirmation, rappel, après
 * séjour, message propre à une chambre). Pur : partagé par l'aide de l'admin et
 * par l'envoi. Une variable inconnue reste telle quelle — l'hôte voit sa faute de
 * frappe dans l'email de test plutôt qu'un trou silencieux.
 */

export const EMAIL_VARIABLES = [
  ["client", "prénom et nom du client"],
  ["prenom", "prénom du client (sinon son nom)"],
  ["chambre", "nom de la chambre"],
  ["arrivee", "date d'arrivée"],
  ["depart", "date de départ"],
  ["nuits", "nombre de nuits"],
  ["voyageurs", "nombre de personnes"],
  ["capacite", "capacité de la chambre"],
  ["lits", "nombre de lits de la chambre"],
  ["etablissement", "nom de votre établissement"],
] as const;

export type EmailVariable = (typeof EMAIL_VARIABLES)[number][0];

export type EmailTemplateContext = {
  guestName: string;
  /** Vide pour une saisie admin sans prénom : {prenom} retombe alors sur le nom complet. */
  guestFirstName?: string;
  roomName: string;
  checkIn: Date;
  checkOut: Date;
  nights: number;
  guestCount?: number;
  roomCapacity?: number;
  roomBeds?: number | null;
  hotelName: string;
  /** Infos pratiques de la chambre ({etage}, {wifi}, infos libres) — `roomInfoVariables`. */
  roomInfo?: Record<string, string>;
};

const longDate = (d: Date) =>
  d.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

export function emailVariables(c: EmailTemplateContext): Record<EmailVariable, string> & Record<string, string> {
  return {
    // Les infos de la chambre d'abord : une variable de l'email n'est jamais écrasée.
    ...c.roomInfo,
    client: c.guestName,
    prenom: c.guestFirstName?.trim() || c.guestName,
    chambre: c.roomName,
    arrivee: longDate(c.checkIn),
    depart: longDate(c.checkOut),
    nuits: String(c.nights),
    voyageurs: c.guestCount !== undefined ? String(c.guestCount) : "",
    capacite: c.roomCapacity !== undefined ? String(c.roomCapacity) : "",
    lits: c.roomBeds != null ? String(c.roomBeds) : "",
    etablissement: c.hotelName,
  };
}

/** Remplace `{variable}` (accents et casse tolérés : {Arrivée}) ; le texte n'est pas échappé ici. */
export function fillTemplate(text: string, vars: Record<string, string>): string {
  return text.replace(/\{([^{}\s]{1,30})\}/g, (whole, name: string) => {
    const key = name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
    return key in vars ? vars[key] : whole;
  });
}

/** Rappel avant l'arrivée : délai par défaut et borne de la saisie (jours). */
export const DEFAULT_REMINDER_DAYS = 2;
export const MAX_REMINDER_DAYS = 30;

/** Délai effectif du rappel ; 0 = rappel désactivé. */
export function reminderDays(config: { reminderDaysBefore?: number }): number {
  const d = config.reminderDaysBefore;
  return typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= MAX_REMINDER_DAYS ? d : DEFAULT_REMINDER_DAYS;
}

/**
 * Le rappel part-il aujourd'hui ? Oui si l'arrivée est dans `days` jours ou moins
 * (rattrape un cron manqué) et que la réservation existait déjà à ce moment-là :
 * une réservation prise la veille ne reçoit pas un « rappel » juste après sa confirmation.
 */
export function reminderDue(
  { checkIn, createdAt }: { checkIn: Date; createdAt: Date | null },
  today: Date,
  days: number,
): boolean {
  if (days === 0) return false;
  const DAY = 86_400_000;
  const until = Math.round((checkIn.getTime() - today.getTime()) / DAY);
  if (until < 1 || until > days) return false;
  return !createdAt || createdAt.getTime() <= checkIn.getTime() - days * DAY;
}
