import { z } from "zod";
import { parisToday } from "@/lib/date-windows";
import { EXTRA_UNITS, FEE_UNITS, MAX_CHOSEN } from "@/lib/extras";
import { isCountryCode } from "@/lib/countries";

// ── Primitives réutilisables ──────────────────────────────────────────────────

/** « 05/01/2027 » → « 2027-01-05 » ; toute autre chaîne est rendue telle quelle. */
export function frDateToIso(v: string): string {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v.trim());
  return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : v;
}

// Les champs date de l'admin affichent JJ/MM/AAAA ; l'API et les tests envoient YYYY-MM-DD. Les deux sont acceptés.
const dateString = z.preprocess(
  (v) => (typeof v === "string" ? frDateToIso(v) : v),
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Format de date attendu : JJ/MM/AAAA")
    .refine((s) => {
      // Rejette aussi les dates qui « débordent » (31/02 → 3 mars)
      const d = new Date(s + "T00:00:00.000Z");
      return !isNaN(d.getTime()) && d.toISOString().startsWith(s);
    }, "Date invalide"),
);

/** Borne de séjour : au-delà, c'est une faute de frappe ou un abus (une requête = une boucle par nuit). */
export const MAX_STAY_NIGHTS = 366;
export const STAY_TOO_LONG_MESSAGE = `Séjour trop long (${MAX_STAY_NIGHTS} nuits maximum)`;

export function isStayTooLong(checkIn: Date, checkOut: Date): boolean {
  return checkOut.getTime() - checkIn.getTime() > MAX_STAY_NIGHTS * 86_400_000;
}

const stayNotTooLong = (d: { checkIn: string; checkOut: string }) =>
  !isStayTooLong(new Date(d.checkIn + "T00:00:00Z"), new Date(d.checkOut + "T00:00:00Z"));

const uuidString = z.string().uuid("UUID invalide");
// Un roomId invalide vient d'un select laissé vide : on le dit dans les mots de l'hôte.
const roomIdString = z.string().uuid("Choisissez une chambre");

export function isUuid(s: string): boolean {
  return uuidString.safeParse(s).success;
}

const email = z.string().email("Adresse email invalide").max(320);

const phone = z
  .string()
  .max(30, "Numéro trop long")
  .regex(/^[+\d\s()./-]*$/, "Numéro de téléphone invalide")
  .optional()
  .or(z.literal(""));

const safeName = z
  .string()
  .min(1, "Champ obligatoire")
  .max(200, "Trop long (200 caractères max)");

const safeText = z.string().max(5000, "Texte trop long (5000 caractères max)");

const positiveInt = z.coerce
  .number()
  .int("Doit être un entier")
  .positive("Doit être supérieur à 0");

// « Dont enfants (−18 ans) » : absent (taxe désactivée) ou vide = 0.
const childCount = z.coerce
  .number({ message: "Nombre d'enfants invalide" })
  .int("Doit être un entier")
  .min(0, "Ne peut pas être négatif")
  .default(0);
const childrenWithinGuests: [(d: { guestCount: number; childCount: number }) => boolean, { message: string; path: string[] }] = [
  (d) => d.childCount <= d.guestCount,
  { message: "Plus d'enfants que de personnes", path: ["childCount"] },
];

const positiveDecimal = z
  .string()
  .regex(/^\d+([.,]\d{1,2})?$/, "Format de prix invalide (ex: 85 ou 85.50)")
  .refine((s) => parseFloat(s.replace(",", ".")) > 0, "Le prix doit être supérieur à 0");

// ── URL iCal (anti-SSRF) ─────────────────────────────────────────────────────

const BLOCKED_HOSTS = /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+|0\.0\.0\.0|\[::1?\])/i;

const icalUrl = z
  .string()
  .url("URL invalide")
  .max(2000, "URL trop longue")
  .refine((url) => {
    try {
      const parsed = new URL(url);
      return parsed.protocol === "https:" || parsed.protocol === "http:";
    } catch {
      return false;
    }
  }, "Seuls les protocoles HTTP et HTTPS sont autorisés")
  .refine((url) => {
    try {
      const parsed = new URL(url);
      return !BLOCKED_HOSTS.test(parsed.hostname);
    } catch {
      return false;
    }
  }, "URL vers un réseau interne non autorisée");

// ── Schémas par action ────────────────────────────────────────────────────────

// Site public : on doit pouvoir joindre le client (téléphone) et l'identifier (prénom, nom, adresse).
const requiredPhone = z
  .string()
  .trim()
  .min(1, "Téléphone obligatoire")
  .max(30, "Numéro trop long")
  .regex(/^[+\d\s()./-]*$/, "Numéro de téléphone invalide")
  .refine((s) => s.replace(/\D/g, "").length >= 6, "Numéro de téléphone incomplet");
const personName = (label: string) =>
  z.string().trim().min(1, `${label} obligatoire`).max(100, `${label} : 100 caractères max`);

/** Voyageur du site public : saisi une fois, pour une chambre comme pour plusieurs. */
const publicGuestFields = {
  guestFirstName: personName("Prénom"),
  guestLastName: personName("Nom"),
  guestEmail: email,
  guestPhone: requiredPhone,
  guestAddress: z
    .string()
    .trim()
    .min(5, "Adresse obligatoire (rue, code postal, ville)")
    .max(300, "Adresse trop longue (300 caractères max)"),
  guestCountry: z.string().trim().toUpperCase().refine(isCountryCode, "Choisissez un pays dans la liste"),
};

export const bookingPublicSchema = z
  .object({
    roomId: roomIdString,
    checkIn: dateString,
    checkOut: dateString,
    ...publicGuestFields,
    guestCount: positiveInt,
    childCount,
  })
  .refine(...childrenWithinGuests)
  .refine(
    (d) => new Date(d.checkOut + "T00:00:00Z") > new Date(d.checkIn + "T00:00:00Z"),
    { message: "La date de départ doit être après la date d'arrivée", path: ["checkOut"] },
  )
  .refine(stayNotTooLong, { message: STAY_TOO_LONG_MESSAGE, path: ["checkOut"] })
  // Public seulement : l'hôte peut saisir un séjour passé (régularisation), pas un client.
  .refine((d) => d.checkIn >= parisToday(), {
    message: "La date d'arrivée est déjà passée",
    path: ["checkIn"],
  });

/** Une chambre d'une réservation multi-chambres : répartition et options (montants jamais lus). */
const dossierRoomPlan = z.object({
  roomId: z.string().uuid("Chambre inconnue"),
  // Bornes larges : la cohérence (capacité, adulte par chambre…) est dite par validateCombination.
  guests: z.number().int().min(0).max(99),
  minors: z.number().int().min(0).max(99),
  extraIds: z.array(z.string()).max(50).default([]),
  extraQuantities: z.record(z.string(), z.number()).default({}),
});

/** Plafond de personnes d'une réservation en ligne (même borne que la recherche). */
export const MAX_PARTY = 50;

/** Réservation de plusieurs chambres sur le site public (Dossier, ADR-0012). */
export const dossierPublicSchema = z
  .object({
    checkIn: dateString,
    checkOut: dateString,
    ...publicGuestFields,
    adults: z.coerce.number({ message: "Nombre d'adultes invalide" }).int("Nombre d'adultes invalide").min(1, "Au moins un adulte"),
    minors: z.coerce.number({ message: "Nombre d'enfants invalide" }).int("Nombre d'enfants invalide").min(0, "Nombre d'enfants invalide").default(0),
    plan: z.preprocess(
      (v) => {
        if (typeof v !== "string") return v;
        try {
          return JSON.parse(v);
        } catch {
          return undefined;
        }
      },
      z.array(dossierRoomPlan, { message: "Choisissez vos chambres" }).min(1, "Choisissez au moins une chambre").max(30, "Trop de chambres"),
    ),
  })
  .refine((d) => d.adults + d.minors <= MAX_PARTY, {
    message: `${MAX_PARTY} personnes maximum par réservation en ligne`,
    path: ["adults"],
  })
  .refine(
    (d) => new Date(d.checkOut + "T00:00:00Z") > new Date(d.checkIn + "T00:00:00Z"),
    { message: "La date de départ doit être après la date d'arrivée", path: ["checkOut"] },
  )
  .refine(stayNotTooLong, { message: STAY_TOO_LONG_MESSAGE, path: ["checkOut"] })
  .refine((d) => d.checkIn >= parisToday(), { message: "La date d'arrivée est déjà passée", path: ["checkIn"] });

export const bookingManualSchema = z
  .object({
    roomId: roomIdString,
    // Prénom facultatif côté admin (client connu par son seul nom, réservation d'une plateforme).
    guestFirstName: z.string().trim().max(100, "Prénom : 100 caractères max").optional().default(""),
    guestLastName: personName("Nom"),
    guestEmail: email,
    guestPhone: phone,
    guestCount: positiveInt,
    childCount,
    checkIn: dateString,
    checkOut: dateString,
    notes: safeText.optional().or(z.literal("")),
    // Total convenu avec le client ; vide = prix calculé par les règles tarifaires.
    agreedPrice: z
      .string()
      .trim()
      .regex(/^\d+([.,]\d{1,2})?$/, "Prix convenu : un montant en euros (ex : 250 ou 249,50)")
      .optional()
      .or(z.literal("")),
    // Case « Forcer » : autorise l'admission par-dessus un Hold (override admin).
    // Checkbox absente si décochée → false ; "on" si cochée → true.
    force: z
      .string()
      .optional()
      .transform((v) => v === "on"),
    // Case « Exonérer de la taxe de séjour » (ADR-0011).
    waiveTax: z
      .string()
      .optional()
      .transform((v) => v === "on"),
  })
  .refine(...childrenWithinGuests)
  .refine(
    (d) => new Date(d.checkOut + "T00:00:00Z") > new Date(d.checkIn + "T00:00:00Z"),
    { message: "La date de départ doit être après la date d'arrivée", path: ["checkOut"] },
  )
  .refine(stayNotTooLong, { message: STAY_TOO_LONG_MESSAGE, path: ["checkOut"] });

/**
 * Chambres supplémentaires d'un Dossier saisi par l'hôte (ADR-0012) : champ caché `moreRooms`
 * (JSON). Mêmes dates et même voyageur que la chambre principale ; vide = une seule chambre.
 */
export const manualMoreRoomsSchema = z.preprocess(
  (v) => {
    if (v === null || v === undefined || v === "") return [];
    if (typeof v !== "string") return v;
    try {
      return JSON.parse(v);
    } catch {
      return undefined;
    }
  },
  z
    .array(
      z
        .object({
          roomId: roomIdString,
          guestCount: positiveInt.refine((n) => n <= MAX_PARTY, `${MAX_PARTY} personnes maximum`),
          childCount,
        })
        .refine(...childrenWithinGuests),
      { message: "Chambres supplémentaires invalides" },
    )
    .max(29, "30 chambres maximum par Dossier"),
);

export const roomSchema = z.object({
  nom: safeName,
  description: safeText.optional().or(z.literal("")),
  prix: positiveDecimal,
  capacite: positiveInt.refine((n) => n <= 50, "Capacité max : 50 personnes"),
  // Vide = non renseigné.
  lits: z
    .preprocess((v) => (v === "" ? undefined : v), positiveInt.refine((n) => n <= 50, "Lits : 50 maximum").optional())
    .transform((v) => v ?? null),
});

/** Paramètres → Emails, bloc d'une chambre (les infos pratiques sont lues par `readRoomInfo`). */
export const roomEmailSchema = z.object({
  messageEmail: safeText.optional().or(z.literal("")),
});

export const roomUpdateSchema = roomSchema.extend({
  actif: z.enum(["on"]).optional(),
});

// Extra du catalogue (ADR-0010) : gratuit permis (lit bébé sur demande), jamais négatif.
export const extraSchema = z.object({
  label: z.string().trim().min(1, "Libellé obligatoire").max(500, "Libellé trop long (500 caractères max)"),
  description: z.string().trim().max(500, "Description trop longue (500 caractères max)").optional().or(z.literal("")),
  price: z
    .string()
    .trim()
    .regex(/^\d+([.,]\d{1,2})?$/, "Prix : un montant positif ou nul en euros (ex : 12 ou 8,50)")
    .refine((s) => parseFloat(s.replace(",", ".")) < 100000, "Prix trop élevé"),
  unit: z.enum(EXTRA_UNITS, { message: "Choisissez une unité" }),
  // « Par séjour » : nombre que le client peut choisir ; vide ou 1 = pas de choix (null). Ignoré sinon.
  maxQuantity: z
    .preprocess(
      (v) => (v === "" || v === undefined || v === null ? undefined : v),
      z.coerce
        .number({ message: "Quantité maximum : un nombre entier" })
        .int("Quantité maximum : un nombre entier")
        .min(1, "Quantité maximum : au moins 1")
        .max(MAX_CHOSEN, `Quantité maximum : ${MAX_CHOSEN} au plus`)
        .optional(),
    )
    .transform((n) => (n && n > 1 ? n : null)),
});

// Fee (ADR-0011) : même forme qu'un Extra, sans description ; chambres en cases à cocher (lues à part).
export const feeSchema = extraSchema
  .omit({ description: true, maxQuantity: true })
  .extend({ unit: z.enum(FEE_UNITS, { message: "Choisissez une unité" }) });

/** Montant décimal positif ou nul saisi à la française (virgule ou point). */
const frDecimal = (label: string, max: number) =>
  z
    .string()
    .trim()
    .regex(/^\d+([.,]\d{1,2})?$/, `${label} : un nombre positif (ex : 1,50)`)
    .transform((s) => parseFloat(s.replace(",", ".")))
    .refine((n) => n <= max, `${label} : ${max} maximum`);

// Taxe de séjour (ADR-0011) : seuls les champs du mode choisi sont lus.
export const touristTaxSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("off") }),
  z.object({ mode: z.literal("fixed"), amount: frDecimal("Montant", 100) }),
  z.object({
    mode: z.literal("percentage"),
    rate: frDecimal("Taux", 5).refine((n) => n >= 1, "Taux : entre 1 et 5 % (loi)"),
    cap: frDecimal("Plafond", 100).refine((n) => n > 0, "Plafond obligatoire"),
    vat: frDecimal("TVA", 100),
    additional: frDecimal("Taxes additionnelles", 500),
  }),
]);

export const icalSourceSchema = z.object({
  roomId: roomIdString,
  name: safeName,
  url: icalUrl,
});

// ── Règles de réservation ────────────────────────────────────────────────────

// Chambres visées : champs `roomIds` répétés, lus par l'action (vide = toutes).
export const manualBlockSchema = z
  .object({
    startDate: dateString,
    endDate: dateString,
    recurring: z.enum(["on"]).optional(),
    recurrenceType: z.enum(["weekly"]).optional(),
    recurrenceDays: z.string().optional().or(z.literal("")), // "0,1,6"
    recurrenceUntil: dateString.optional().or(z.literal("")),
  })
  .refine(
    (d) => {
      if (d.recurring === "on") return true; // pas de contrainte date pour récurrent
      // Fin exclusive : fin = début bloquerait zéro nuit.
      return new Date(d.endDate + "T00:00:00Z") > new Date(d.startDate + "T00:00:00Z");
    },
    { message: "La date de fin doit être après la date de début", path: ["endDate"] },
  );

const periodInOrder: [(d: { validFrom?: string; validTo?: string }) => boolean, { message: string; path: string[] }] = [
  (d) => !d.validFrom || !d.validTo || d.validTo >= d.validFrom,
  { message: "La fin de période doit être après le début", path: ["validTo"] },
];

export const bookingRuleSchema = z.object({
  validFrom: dateString.optional().or(z.literal("")),
  validTo: dateString.optional().or(z.literal("")),
  minStay: z.coerce.number().int("Nombre de nuits entier").min(1, "Au moins 1 nuit").optional().or(z.literal("").transform(() => undefined)),
  maxStay: z.coerce.number().int("Nombre de nuits entier").min(1, "Au moins 1 nuit").optional().or(z.literal("").transform(() => undefined)),
  allowedCheckInDays: z.string().optional().or(z.literal("")), // "6" ou "0,6"
  allowedCheckOutDays: z.string().optional().or(z.literal("")),
}).refine(...periodInOrder);

const percentageModifier = z
  .string()
  .regex(/^-?\d+([.,]\d{1,2})?$/, "Format invalide (ex: 30 ou -15.50)")
  // -100 % = nuit à 0 € : Stripe refuse tout paiement sous 0,50 €.
  .refine((s) => parseFloat(s.replace(",", ".")) > -100, "La réduction doit rester inférieure à 100 %");

/** Valeur seule d'une règle tarifaire (saisie « un prix par chambre »). */
export const pricingValueSchema = { fixedPrice: positiveDecimal, percentageModifier };

export const pricingRuleSchema = z
  .object({
    name: safeName,
    validFrom: dateString.optional().or(z.literal("")),
    validTo: dateString.optional().or(z.literal("")),
    daysOfWeek: z.string().optional().or(z.literal("")), // "5,6"
    fixedPrice: positiveDecimal.optional().or(z.literal("")),
    percentageModifier: percentageModifier.optional().or(z.literal("")),
  })
  .refine(
    (d) => {
      const hasFP = d.fixedPrice && d.fixedPrice !== "";
      const hasPM = d.percentageModifier && d.percentageModifier !== "";
      return hasFP || hasPM;
    },
    { message: "Indiquez un prix fixe ou un modificateur en pourcentage", path: ["fixedPrice"] },
  )
  .refine(...periodInOrder);

export const locationSchema = z.object({
  googleMapsUrl: z
    .string()
    .max(2000, "URL trop longue")
    .refine(
      (url) => {
        if (!url) return true;
        try {
          const parsed = new URL(url);
          return (
            parsed.hostname.includes("google") ||
            parsed.hostname.includes("goo.gl") ||
            parsed.hostname.includes("maps.app")
          );
        } catch {
          return false;
        }
      },
      "L'URL doit être un lien Google Maps",
    )
    .optional()
    .or(z.literal("")),
  latitude: z
    .string()
    .refine(
      (s) => {
        if (!s) return true;
        const n = parseFloat(s);
        return !isNaN(n) && n >= -90 && n <= 90;
      },
      "Latitude invalide (entre -90 et 90)",
    )
    .optional()
    .or(z.literal("")),
  longitude: z
    .string()
    .refine(
      (s) => {
        if (!s) return true;
        const n = parseFloat(s);
        return !isNaN(n) && n >= -180 && n <= 180;
      },
      "Longitude invalide (entre -180 et 180)",
    )
    .optional()
    .or(z.literal("")),
});

// ── Helper : parse un FormData avec un schéma Zod ────────────────────────────

function formEntries(formData: FormData): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  for (const [key, value] of formData.entries()) {
    raw[key] = typeof value === "string" ? value : undefined;
  }
  return raw;
}

export function parseFormData<T extends z.ZodTypeAny>(
  schema: T,
  formData: FormData,
): z.infer<T> {
  return schema.parse(formEntries(formData));
}

// ── Résultat des server actions de formulaire ────────────────────────────────
// Une erreur levée par une server action est masquée en production (digest) :
// les erreurs de saisie sont donc RENDUES au client, jamais levées.

/** `undefined` = succès ; sinon un message FR prêt à afficher et, par champ, son erreur. */
export type FormResult = { error: string; fieldErrors: Record<string, string> } | undefined;

export function formError(e: z.ZodError): NonNullable<FormResult> {
  const fieldErrors: Record<string, string> = {};
  for (const i of e.issues) {
    const name = String(i.path[0] ?? "");
    if (name && !fieldErrors[name]) fieldErrors[name] = i.message;
  }
  return { error: e.issues.map((i) => i.message).join(" · "), fieldErrors };
}

/** Comme parseFormData, mais rend l'erreur de saisie au lieu de la lever. */
export function safeParseFormData<T extends z.ZodTypeAny>(
  schema: T,
  formData: FormData,
): { data: z.infer<T> } | NonNullable<FormResult> {
  const r = schema.safeParse(formEntries(formData));
  return r.success ? { data: r.data } : formError(r.error);
}
