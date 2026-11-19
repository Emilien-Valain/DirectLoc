import {
  pgTable,
  pgEnum,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  decimal,
  index,
  uniqueIndex,
  unique,
} from "drizzle-orm/pg-core";

// ─── TENANTS ────────────────────────────────────────────────────────────────

export const tenants = pgTable(
  "tenants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    domain: text("domain").unique(),
    config: jsonb("config").notNull().default({}),
    stripeAccountId: text("stripe_account_id"),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [index("tenants_domain_idx").on(table.domain)],
);

// ─── USERS (Better Auth — admins) ────────────────────────────────────────────
// IDs gérés par Better Auth (text/nanoid, pas uuid)
// Les champs emailVerified, image, updatedAt sont requis par Better Auth

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ─── AUTH — Sessions ──────────────────────────────────────────────────────────

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at").notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
});

// ─── AUTH — Accounts ──────────────────────────────────────────────────────────

export const accounts = pgTable("accounts", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ─── AUTH — Verifications ────────────────────────────────────────────────────

export const verifications = pgTable("verifications", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// ─── USER ↔ TENANT (many-to-many) ────────────────────────────────────────────
// Permet à un admin de gérer plusieurs tenants (hôtels).

export const userTenants = pgTable(
  "user_tenants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("admin"),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    unique("user_tenants_user_tenant_unique").on(table.userId, table.tenantId),
    index("user_tenants_user_idx").on(table.userId),
    index("user_tenants_tenant_idx").on(table.tenantId),
  ],
);

// ─── PROPERTIES ──────────────────────────────────────────────────────────────

export const properties = pgTable("properties", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id),
  name: text("name").notNull(),
  description: text("description"),
  address: text("address"),
  createdAt: timestamp("created_at").defaultNow(),
});

// ─── ROOMS ───────────────────────────────────────────────────────────────────

export const rooms = pgTable(
  "rooms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => properties.id),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    pricePerNight: decimal("price_per_night", {
      precision: 10,
      scale: 2,
    }).notNull(),
    capacity: integer("capacity").notNull().default(2),
    // Nombre de lits ; null = non renseigné (une option « par lit » se borne alors à la capacité).
    beds: integer("beds"),
    // Message ajouté aux emails de confirmation et de rappel de cette chambre (variables {client}…).
    emailMessage: text("email_message"),
    // Infos pratiques [{ key, label, value }] (étage, code, wifi, infos libres) → variables {etage}… (lib/room-info.ts).
    info: jsonb("info").notNull().default([]),
    photos: jsonb("photos").notNull().default([]),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at").defaultNow(),
  },
  // Unique par tenant : /chambres/[slug] doit désigner une seule chambre
  (table) => [uniqueIndex("rooms_slug_tenant_idx").on(table.tenantId, table.slug)],
);

// ─── BOOKINGS ────────────────────────────────────────────────────────────────

export const bookingStatusEnum = pgEnum("booking_status", [
  "pending",
  "confirmed",
  "cancelled",
  "completed",
]);

export const bookings = pgTable(
  "bookings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    roomId: uuid("room_id")
      .notNull()
      .references(() => rooms.id),
    checkIn: timestamp("check_in").notNull(),
    checkOut: timestamp("check_out").notNull(),
    totalPrice: decimal("total_price", { precision: 10, scale: 2 }).notNull(),
    status: bookingStatusEnum("status").notNull().default("pending"),
    // Nom affiché = prénom + nom, recomposé à chaque écriture (listes, emails, recherche).
    guestName: text("guest_name").notNull(),
    // Prénom facultatif (saisie admin) ; réservations antérieures découpées au premier espace.
    guestFirstName: text("guest_first_name").notNull().default(""),
    guestLastName: text("guest_last_name").notNull().default(""),
    guestEmail: text("guest_email").notNull(),
    guestPhone: text("guest_phone"),
    // Adresse postale (obligatoire sur le site public, absente des saisies manuelles anciennes).
    guestAddress: text("guest_address"),
    // Pays de résidence, code ISO 3166-1 alpha-2 (fiche de police des voyageurs étrangers).
    guestCountry: text("guest_country"),
    guestCount: integer("guest_count").notNull().default(1),
    // Dont mineurs (−18 ans), exonérés de taxe de séjour (ADR-0011) ; ≤ guestCount.
    childCount: integer("child_count").notNull().default(0),
    notes: text("notes"),
    source: text("source").notNull().default("direct"),
    // Règlement hors ligne (saisie manuelle) marqué par l'hôte ; le paiement en ligne vit dans `payments`.
    paidAt: timestamp("paid_at"),
    reminderSentAt: timestamp("reminder_sent_at"),
    thankYouSentAt: timestamp("thank_you_sent_at"),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [
    index("bookings_room_dates_idx").on(
      table.roomId,
      table.checkIn,
      table.checkOut,
    ),
    index("bookings_tenant_idx").on(table.tenantId),
  ],
);

// ─── EXTRAS ──────────────────────────────────────────────────────────────────
// Options payantes du catalogue (petit-déj, linge…), toutes chambres (ADR-0010).

export const extraUnitEnum = pgEnum("extra_unit", [
  "per_stay",
  "per_night",
  "per_guest",
  "per_guest_night",
  // Quantité = lits choisis par le client (≤ lits de la chambre), pas dérivée du séjour.
  "per_bed",
]);

export const extras = pgTable(
  "extras",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    label: text("label").notNull(),
    description: text("description"),
    price: decimal("price", { precision: 10, scale: 2 }).notNull(),
    unit: extraUnitEnum("unit").notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [index("extras_tenant_idx").on(table.tenantId)],
);

// ─── FEES ────────────────────────────────────────────────────────────────────
// Frais obligatoires (ménage, frais de dossier…), appliqués d'office (ADR-0011).

export const fees = pgTable(
  "fees",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    label: text("label").notNull(),
    price: decimal("price", { precision: 10, scale: 2 }).notNull(),
    unit: extraUnitEnum("unit").notNull(),
    // Chambres concernées ; vide = toutes. Pas de FK : un id de chambre supprimée ne matche plus rien.
    roomIds: uuid("room_ids").array().notNull().default([]),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => [index("fees_tenant_idx").on(table.tenantId)],
);

// Tout ce qui s'ajoute à l'hébergement d'une réservation (ADR-0010, ADR-0011) :
// Extras, Fees et taxe de séjour, copiés (libellé, unité, prix) à l'admission.
// `totalPrice` = hébergement + Σ total. Quantité dérivée, jamais saisie.
export const bookingLineKindEnum = pgEnum("booking_line_kind", ["extra", "fee", "tax"]);

export const bookingLines = pgTable(
  "booking_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => bookings.id, { onDelete: "cascade" }),
    kind: bookingLineKindEnum("kind").notNull(),
    // Extra ou Fee d'origine (pas de FK : polymorphe, et la copie survit à sa suppression).
    sourceId: uuid("source_id"),
    label: text("label").notNull(),
    unit: extraUnitEnum("unit").notNull(),
    unitPrice: decimal("unit_price", { precision: 10, scale: 2 }).notNull(),
    quantity: integer("quantity").notNull(),
    total: decimal("total", { precision: 10, scale: 2 }).notNull(),
    // Fee ou taxe retirés par l'admin : ligne gardée à 0 € (export de la taxe).
    exempt: boolean("exempt").notNull().default(false),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [index("booking_lines_booking_idx").on(table.bookingId)],
);

// ─── PAYMENTS ────────────────────────────────────────────────────────────────

export const payments = pgTable("payments", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id),
  bookingId: uuid("booking_id")
    .notNull()
    .references(() => bookings.id),
  stripeSessionId: text("stripe_session_id").unique(),
  stripePaymentId: text("stripe_payment_id").unique(),
  amount: decimal("amount", { precision: 10, scale: 2 }).notNull(),
  currency: text("currency").notNull().default("eur"),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at").defaultNow(),
});

// ─── ICAL SOURCES ────────────────────────────────────────────────────────────

export const icalSources = pgTable("ical_sources", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id),
  roomId: uuid("room_id")
    .notNull()
    .references(() => rooms.id),
  name: text("name").notNull(),
  url: text("url").notNull(),
  lastSyncAt: timestamp("last_sync_at"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow(),
});

// ─── ICAL BLOCKS ─────────────────────────────────────────────────────────────

export const icalBlocks = pgTable(
  "ical_blocks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    roomId: uuid("room_id")
      .notNull()
      .references(() => rooms.id),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => icalSources.id),
    uid: text("uid").notNull(),
    summary: text("summary"),
    start: timestamp("start").notNull(),
    end: timestamp("end").notNull(),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    unique().on(table.sourceId, table.uid),
    index("ical_blocks_room_dates_idx").on(
      table.roomId,
      table.start,
      table.end,
    ),
  ],
);

// ─── MANUAL BLOCKS ──────────────────────────────────────────────────────────
// Blocages manuels de dates (par chambre ou global)

export const manualBlocks = pgTable(
  "manual_blocks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    roomId: uuid("room_id").references(() => rooms.id), // NULL = toutes les chambres
    startDate: timestamp("start_date").notNull(),
    endDate: timestamp("end_date").notNull(),
    recurring: boolean("recurring").notNull().default(false),
    recurrenceType: text("recurrence_type"), // "weekly"
    recurrenceDays: jsonb("recurrence_days").default([]), // [0..6] (0=dimanche)
    recurrenceUntil: timestamp("recurrence_until"), // NULL = indéfini
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("manual_blocks_tenant_room_idx").on(table.tenantId, table.roomId),
    index("manual_blocks_dates_idx").on(table.startDate, table.endDate),
  ],
);

// ─── BOOKING RULES ──────────────────────────────────────────────────────────
// Règles de réservation (global tenant ou override par chambre)

export const bookingRules = pgTable(
  "booking_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    roomId: uuid("room_id").references(() => rooms.id), // NULL = règle globale
    validFrom: timestamp("valid_from"), // NULL = toute l'année
    validTo: timestamp("valid_to"),
    minStay: integer("min_stay"), // nuits minimum
    maxStay: integer("max_stay"), // nuits maximum
    allowedCheckInDays: jsonb("allowed_check_in_days"), // [0..6] ou NULL = tous
    allowedCheckOutDays: jsonb("allowed_check_out_days"), // [0..6] ou NULL = tous
    priority: integer("priority").notNull().default(0),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("booking_rules_tenant_room_idx").on(table.tenantId, table.roomId),
    index("booking_rules_validity_idx").on(table.validFrom, table.validTo),
  ],
);

// ─── PRICING RULES ──────────────────────────────────────────────────────────
// Tarification dynamique (global % ou override chambre prix fixe)

export const pricingRules = pgTable(
  "pricing_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    // Chambres visées ; vide = toutes. Pas de FK : un id de chambre supprimée ne matche plus rien.
    roomIds: uuid("room_ids").array().notNull().default([]),
    // Règles créées ensemble « une valeur par chambre » : même nom, période et jours, une
    // chambre chacune. Affichées, modifiées, activées et supprimées d'un bloc. NULL = seule.
    groupId: uuid("group_id"),
    name: text("name").notNull(), // "Haute saison", "Week-end", etc.
    validFrom: timestamp("valid_from"), // NULL = toute l'année
    validTo: timestamp("valid_to"),
    daysOfWeek: jsonb("days_of_week"), // [0..6] ou NULL = tous les jours
    fixedPrice: decimal("fixed_price", { precision: 10, scale: 2 }), // prix fixe par nuit
    percentageModifier: decimal("percentage_modifier", {
      precision: 6,
      scale: 2,
    }), // ex: 30.00 = +30%, -15.00 = -15%
    priority: integer("priority").notNull().default(0),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("pricing_rules_tenant_idx").on(table.tenantId),
    index("pricing_rules_validity_idx").on(table.validFrom, table.validTo),
  ],
);
