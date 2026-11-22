/**
 * Réseau des Voisins (ADR-0013) — notifications à la confirmation d'un Dossier.
 *
 * Fait partie du module réseau : c'est le seul autre endroit qui lit un tenant pour le compte
 * d'un autre, et il n'en sort que des faits publics (nom, téléphone de l'établissement) et des
 * dates. Aucune donnée voyageur ne part chez l'autre hôte.
 *
 * Une seule notification par Dossier : chaque envoi est réservé d'abord par un UPDATE … WHERE
 * marqueur IS NULL (webhook rejoué, double clic, saisie admin) — `dossiers.network_notified_at`
 * pour l'attribution, `referrals.share_notified_at` pour l'échange des contacts d'un groupe partagé.
 */
import { and, desc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { bookings, dossiers, referrals, tenants } from "@/db/schema";
import { sendNetworkNotice, type NetworkPartner } from "@/lib/email";
import { tenantAdminEmails } from "@/lib/refund-sync";
import type { TenantConfig } from "@/lib/tenant-context";

const isConfirmed = async (dossierId: string) =>
  (
    await db
      .select({ id: bookings.id })
      .from(bookings)
      .where(and(eq(bookings.dossierId, dossierId), inArray(bookings.status, ["confirmed", "completed"])))
      .limit(1)
  ).length > 0;

async function hotel(tenantId: string) {
  const [t] = await db.select({ name: tenants.name, config: tenants.config }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  const config = (t?.config ?? {}) as TenantConfig;
  return { tenantId, name: t?.name ?? "Établissement", config, contact: { name: t?.name ?? "Établissement", phone: config.phone?.trim() || null } as NetworkPartner };
}

/**
 * Partage d'un groupe : relie le Dossier confirmé du Voisin au Renvoi partagé de l'hôte qui l'a
 * envoyé (mêmes hôtels, mêmes dates, Dossier de l'hôte connu, pas encore relié ; le plus récent).
 * Deux Renvois identiques ne se distinguent pas, mais ils désignent les deux mêmes hôtels : le
 * contact échangé est le même.
 */
async function linkSharedReferral(d: { id: string; tenantId: string; referredByTenantId: string; checkIn: Date; checkOut: Date }) {
  const [already] = await db.select({ id: referrals.id }).from(referrals).where(eq(referrals.toDossierId, d.id)).limit(1);
  if (already) return;
  const [candidate] = await db
    .select({ id: referrals.id })
    .from(referrals)
    .where(
      and(
        eq(referrals.fromTenantId, d.referredByTenantId),
        eq(referrals.toTenantId, d.tenantId),
        eq(referrals.kind, "shared"),
        eq(referrals.checkIn, d.checkIn),
        eq(referrals.checkOut, d.checkOut),
        isNotNull(referrals.fromDossierId),
        isNull(referrals.toDossierId),
      ),
    )
    .orderBy(desc(referrals.createdAt))
    .limit(1);
  if (!candidate) return;
  try {
    await db.update(referrals).set({ toDossierId: d.id }).where(and(eq(referrals.id, candidate.id), isNull(referrals.toDossierId)));
  } catch {
    // Index unique sur to_dossier_id : une confirmation concurrente l'a déjà relié.
  }
}

/**
 * À appeler quand un Dossier vient d'être confirmé (paiement Stripe, saisie admin, confirmation
 * manuelle). Sans effet si le Dossier n'est pas confirmé, ni attribué au réseau, ni d'un groupe
 * partagé, ou si ses emails sont déjà partis. Best-effort : n'échoue jamais.
 */
export async function notifyNetworkConfirmation(dossierId: string, tenantId: string): Promise<void> {
  try {
    const [d] = await db
      .select({ id: dossiers.id, tenantId: dossiers.tenantId, referredByTenantId: dossiers.referredByTenantId, checkIn: dossiers.checkIn, checkOut: dossiers.checkOut })
      .from(dossiers)
      .where(and(eq(dossiers.id, dossierId), eq(dossiers.tenantId, tenantId)))
      .limit(1);
    if (!d || !(await isConfirmed(d.id))) return;

    if (d.referredByTenantId) await linkSharedReferral({ ...d, referredByTenantId: d.referredByTenantId });

    // Groupe partagé : les deux Dossiers confirmés → échange des contacts, une fois.
    let share: { fromTenantId: string; toTenantId: string } | null = null;
    const [link] = await db
      .select({ id: referrals.id, fromTenantId: referrals.fromTenantId, toTenantId: referrals.toTenantId, fromDossierId: referrals.fromDossierId, toDossierId: referrals.toDossierId })
      .from(referrals)
      .where(and(eq(referrals.kind, "shared"), or(eq(referrals.fromDossierId, d.id), eq(referrals.toDossierId, d.id)), isNotNull(referrals.fromDossierId), isNotNull(referrals.toDossierId)))
      .limit(1);
    const sharedWith = !!link && link.toDossierId === d.id;
    if (link && (await isConfirmed(link.fromDossierId!)) && (await isConfirmed(link.toDossierId!))) {
      const [claimed] = await db
        .update(referrals)
        .set({ shareNotifiedAt: sql`now()` })
        .where(and(eq(referrals.id, link.id), isNull(referrals.shareNotifiedAt)))
        .returning({ id: referrals.id });
      if (claimed) share = link;
    }

    // Attribution : Voisin + envoyeur, une fois par Dossier.
    const [attributed] = await db
      .update(dossiers)
      .set({ networkNotifiedAt: sql`now()` })
      .where(and(eq(dossiers.id, d.id), eq(dossiers.tenantId, tenantId), isNotNull(dossiers.referredByTenantId), isNull(dossiers.networkNotifiedAt)))
      .returning({ referredByTenantId: dossiers.referredByTenantId });

    const notices: Parameters<typeof sendNetworkNotice>[0][] = [];
    const stay = { checkIn: d.checkIn, checkOut: d.checkOut };
    if (attributed?.referredByTenantId) {
      const [receiver, sender] = await Promise.all([hotel(tenantId), hotel(attributed.referredByTenantId)]);
      // Le partage n'est joint que s'il vient d'être réservé pour ce même couple d'hôtels.
      const withShare = !!share && share.toTenantId === receiver.tenantId && share.fromTenantId === sender.tenantId;
      for (const adminEmail of await tenantAdminEmails(receiver.tenantId)) {
        notices.push({ ...stay, adminEmail, tenantId: receiver.tenantId, hotelName: receiver.name, config: receiver.config, role: "receiver", otherName: sender.name, shared: sharedWith, partner: withShare ? sender.contact : null });
      }
      for (const adminEmail of await tenantAdminEmails(sender.tenantId)) {
        notices.push({ ...stay, adminEmail, tenantId: sender.tenantId, hotelName: sender.name, config: sender.config, role: "sender", otherName: receiver.name, shared: sharedWith, partner: withShare ? receiver.contact : null });
      }
      if (withShare) share = null; // contacts déjà dans ces emails
    }
    if (share) {
      const [from, to] = await Promise.all([hotel(share.fromTenantId), hotel(share.toTenantId)]);
      for (const [me, other] of [[from, to], [to, from]] as const) {
        for (const adminEmail of await tenantAdminEmails(me.tenantId)) {
          notices.push({ ...stay, adminEmail, tenantId: me.tenantId, hotelName: me.name, config: me.config, role: "partner", otherName: other.name, shared: true, partner: other.contact });
        }
      }
    }
    for (const n of notices) {
      try {
        await sendNetworkNotice(n);
      } catch (e) {
        console.error("[réseau] Envoi de notification en erreur", e);
      }
    }
  } catch (e) {
    console.error(`[réseau] Notification du Dossier ${dossierId} en erreur`, e);
  }
}
