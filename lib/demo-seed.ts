import { eq } from "drizzle-orm";
import { randomBytes } from "crypto";
import { db } from "@/lib/db";
import {
  tenants,
  users,
  sessions,
  userTenants,
  properties,
  rooms,
  bookings,
  payments,
  extras,
  fees,
  icalSources,
  icalBlocks,
  manualBlocks,
  bookingRules,
  pricingRules,
} from "@/db/schema";
import { DEMO_TENANT_SLUG, demoUserEmail } from "@/lib/demo";
import { createCredentialUser } from "@/lib/credential-user";
import type { TenantConfig } from "@/lib/tenant-context";

const DEMO_NAME = "Le Mas des Oliviers";

function demoPhoto(name: string) {
  return { id: `demo-${name}`, filename: `${name}.webp`, url: `/demo/${name}.webp` };
}

const DEMO_CONFIG: TenantConfig = {
  template: "classic",
  heroEyebrow: "Maison d'hôtes · Luberon",
  heroTitle: "Le Mas des Oliviers",
  heroSubtitle: "Quatre chambres au calme, entre vignes et lavandes, à dix minutes de Gordes.",
  // Photos Unsplash (licence Unsplash : usage libre, sans attribution) dans public/demo/.
  heroPhoto: demoPhoto("hero-lavande"),
  galleryPhotos: [
    { ...demoPhoto("galerie-mas"), caption: "Le Mas au printemps" },
    { ...demoPhoto("galerie-olivier"), caption: "L'olivier de la cour" },
    { ...demoPhoto("galerie-table"), caption: "Dîner sous la tonnelle" },
    { ...demoPhoto("galerie-lavande"), caption: "Les lavandes du plateau" },
  ],
  storyEyebrow: "Notre histoire",
  storyTitle: "Une ferme du XIXᵉ, rendue à la lumière",
  storyText:
    "Ancienne bergerie restaurée pierre par pierre, le Mas accueille ses hôtes depuis 2015. " +
    "Petit-déjeuner servi sous la tonnelle, piscine face au Ventoux, conseils de balades : " +
    "ici on prend le temps.",
  storyStats: [
    { value: "4", label: "Chambres", sub: "toutes avec vue" },
    { value: "3 ha", label: "D'oliviers", sub: "et de lavande" },
    { value: "1850", label: "Bergerie", sub: "restaurée en 2015" },
    { value: "12 m", label: "Piscine", sub: "au sel" },
  ],
  keyStatsEyebrow: "En chiffres",
  keyStatsTitle: "Le Mas en quelques mots",
  locationEyebrow: "Nous trouver",
  locationTitle: "Au cœur du Luberon",
  locationSubtitle: "Gordes à 10 min, Avignon à 45 min, gare TGV à 40 min.",
  address: "Chemin des Oliviers\n84220 Gordes",
  phone: "+33 4 90 00 12 34",
  email: "bonjour@demo.directloc.app",
  latitude: 43.9112,
  longitude: 5.2003,
  checkInTime: "16:00",
  checkOutTime: "11:00",
  accessLines: ["Parking privé gratuit", "Gare d'Avignon TGV à 40 min", "Aéroport de Marseille à 1 h 15"],
  footerTagline: "Maison d'hôtes de charme dans le Luberon",
  confirmationMessage: "Merci pour votre réservation ! Nous avons hâte de vous accueillir au Mas.",
  postStayMessage: "Merci d'avoir séjourné chez nous, à bientôt dans le Luberon !",
  touristTax: { mode: "fixed", amount: 1.5 },
};

const ROOMS = [
  {
    slug: "chambre-lavande",
    name: "Chambre Lavande",
    price: 95,
    capacity: 2,
    description: "Lit double, douche à l'italienne et fenêtre sur les champs de lavande. Idéale pour un couple.",
  },
  {
    slug: "chambre-olivier",
    name: "Chambre Olivier",
    price: 120,
    capacity: 2,
    description: "Grand lit 180, poutres apparentes et terrasse privative à l'ombre d'un olivier centenaire.",
  },
  {
    slug: "suite-cypres",
    name: "Suite Cyprès",
    price: 180,
    capacity: 3,
    description: "Suite de 40 m² avec salon, baignoire îlot et vue dégagée sur le Ventoux.",
  },
  {
    slug: "famille-garrigue",
    name: "Famille Garrigue",
    price: 150,
    capacity: 4,
    description: "Deux chambres communicantes au rez-de-jardin, parfaites pour une famille avec enfants.",
  },
] as const;

type Status = "pending" | "confirmed" | "cancelled" | "completed";
// [chambre, arrivée J+n, départ J+n, statut, canal, client]
const BOOKINGS: [number, number, number, Status, "direct" | "manual", string][] = [
  [0, -26, -22, "completed", "direct", "Claire Martin"],
  [0, -12, -9, "completed", "manual", "Jean Dupont"],
  [0, -2, 2, "confirmed", "direct", "Sophie Bernard"],
  [0, 6, 9, "confirmed", "direct", "Lucas Petit"],
  [0, 20, 23, "pending", "direct", "Emma Robert"],
  [1, -20, -16, "completed", "direct", "Thomas Richard"],
  [1, -5, -1, "completed", "manual", "Camille Durand"],
  [1, 1, 4, "confirmed", "manual", "Hugo Leroy"],
  [1, 10, 14, "cancelled", "direct", "Léa Moreau"],
  [1, 16, 19, "confirmed", "direct", "Nathan Simon"],
  [2, -15, -10, "completed", "direct", "Chloé Laurent"],
  [2, -1, 3, "confirmed", "direct", "Antoine Lefebvre"],
  [2, 7, 11, "pending", "direct", "Manon Michel"],
  [2, 25, 29, "confirmed", "manual", "Julien Garcia"],
  [3, -28, -24, "cancelled", "direct", "Inès David"],
  [3, -8, -4, "completed", "direct", "Famille Bertrand"],
  [3, 0, 3, "confirmed", "manual", "Famille Roux"],
  [3, 18, 22, "confirmed", "direct", "Famille Vincent"],
];

/**
 * Remet l'hôtel démo (DEMO_TENANT_SLUG) dans son état de référence : crée le tenant et le
 * compte démo s'ils manquent, efface toutes ses données puis réinsère un jeu crédible.
 * Une seule transaction : un échec laisse l'ancienne démo intacte.
 */
export async function resetDemoTenant() {
  const slug = DEMO_TENANT_SLUG;
  if (!slug) throw new Error("DEMO_TENANT_SLUG non configuré");
  const domain = process.env.DEMO_TENANT_DOMAIN || null;
  const email = demoUserEmail();

  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(tenants).where(eq(tenants.slug, slug));
    const [tenant] = existing
      ? await tx
          .update(tenants)
          .set({ name: DEMO_NAME, domain, config: DEMO_CONFIG, stripeAccountId: null })
          .where(eq(tenants.id, existing.id))
          .returning()
      : await tx
          .insert(tenants)
          .values({ name: DEMO_NAME, slug, domain, config: DEMO_CONFIG })
          .returning();
    // Garde-fou : toutes les suppressions ci-dessous filtrent sur cet id.
    if (tenant?.slug !== slug) throw new Error("resetDemoTenant : tenant démo introuvable");
    const t = tenant.id;

    // ── Compte démo (mot de passe aléatoire : la connexion passe par /essayer) ──
    const [demoUser] = await tx.select({ id: users.id }).from(users).where(eq(users.email, email));
    const userId =
      demoUser?.id ??
      (await createCredentialUser(tx, {
        name: DEMO_NAME,
        email,
        password: randomBytes(32).toString("base64url"),
      }));
    await tx.update(users).set({ name: DEMO_NAME }).where(eq(users.id, userId));
    await tx.delete(sessions).where(eq(sessions.userId, userId));
    await tx.insert(userTenants).values({ userId, tenantId: t }).onConflictDoNothing();

    // ── Effacement (ordre imposé par les FK ; booking_lines part en cascade) ──
    await tx.delete(payments).where(eq(payments.tenantId, t));
    await tx.delete(icalBlocks).where(eq(icalBlocks.tenantId, t));
    await tx.delete(icalSources).where(eq(icalSources.tenantId, t));
    await tx.delete(manualBlocks).where(eq(manualBlocks.tenantId, t));
    await tx.delete(bookingRules).where(eq(bookingRules.tenantId, t));
    await tx.delete(pricingRules).where(eq(pricingRules.tenantId, t));
    await tx.delete(extras).where(eq(extras.tenantId, t));
    await tx.delete(fees).where(eq(fees.tenantId, t));
    await tx.delete(bookings).where(eq(bookings.tenantId, t));
    await tx.delete(rooms).where(eq(rooms.tenantId, t));
    await tx.delete(properties).where(eq(properties.tenantId, t));

    // ── Jeu de démo ──
    const now = new Date();
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const day = (n: number) => new Date(today + n * 86_400_000);

    const [property] = await tx
      .insert(properties)
      .values({ tenantId: t, name: "Le Mas des Oliviers", address: "Chemin des Oliviers, 84220 Gordes" })
      .returning();

    const roomRows = await tx
      .insert(rooms)
      .values(
        ROOMS.map((r) => ({
          tenantId: t,
          propertyId: property.id,
          slug: r.slug,
          name: r.name,
          description: r.description,
          pricePerNight: r.price.toFixed(2),
          capacity: r.capacity,
          photos: [{ ...demoPhoto(r.slug), position: 0 }],
        })),
      )
      .returning({ id: rooms.id, slug: rooms.slug });
    const roomId = (i: number) => roomRows.find((r) => r.slug === ROOMS[i].slug)!.id;

    await tx.insert(bookings).values(
      BOOKINGS.map(([i, from, to, status, source, guestName], n) => ({
        tenantId: t,
        roomId: roomId(i),
        checkIn: day(from),
        checkOut: day(to),
        totalPrice: ((to - from) * ROOMS[i].price).toFixed(2),
        status,
        source,
        guestName,
        guestEmail: `client${n + 1}@example.com`,
        guestPhone: source === "manual" ? "+33 6 12 34 56 78" : null,
        guestCount: Math.min(2, ROOMS[i].capacity),
        paidAt: source === "manual" && status === "completed" ? day(to) : null,
        createdAt: day(Math.min(from, 0) - 14),
      })),
    );

    await tx.insert(manualBlocks).values({
      tenantId: t,
      roomId: roomId(3),
      startDate: day(12),
      endDate: day(15),
    });

    const [ical] = await tx
      .insert(icalSources)
      .values({
        tenantId: t,
        roomId: roomId(0),
        name: "Airbnb",
        url: "https://www.airbnb.fr/calendar/ical/demo.ics",
        active: false, // jamais synchronisée : l'URL est fictive
        lastSyncAt: day(0),
      })
      .returning();
    await tx.insert(icalBlocks).values([
      { tenantId: t, roomId: roomId(0), sourceId: ical.id, uid: "demo-airbnb-1", summary: "Airbnb (Not available)", start: day(12), end: day(15) },
      { tenantId: t, roomId: roomId(0), sourceId: ical.id, uid: "demo-airbnb-2", summary: "Airbnb (Not available)", start: day(26), end: day(28) },
    ]);

    await tx.insert(bookingRules).values({ tenantId: t, minStay: 2 });

    const summerYear = now.getUTCMonth() > 7 ? now.getUTCFullYear() + 1 : now.getUTCFullYear();
    await tx.insert(pricingRules).values({
      tenantId: t,
      name: "Haute saison",
      validFrom: new Date(Date.UTC(summerYear, 6, 1)),
      validTo: new Date(Date.UTC(summerYear, 7, 31)),
      percentageModifier: "25.00",
    });

    await tx.insert(extras).values([
      { tenantId: t, label: "Petit-déjeuner provençal", description: "Servi sous la tonnelle", price: "14.00", unit: "per_guest_night" },
      { tenantId: t, label: "Panier pique-nique", description: "Pour vos balades dans le Luberon", price: "22.00", unit: "per_stay" },
    ]);
    await tx.insert(fees).values({ tenantId: t, label: "Ménage de fin de séjour", price: "25.00", unit: "per_stay" });

    return { tenantId: t, rooms: roomRows.length, bookings: BOOKINGS.length };
  });
}
