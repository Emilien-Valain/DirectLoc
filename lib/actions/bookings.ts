"use server";

import { fullName } from "@/lib/guest-name";
import { and, eq, gt, inArray, lt, ne } from "drizzle-orm";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/session";
import { captureServer } from "@/lib/analytics";
import { db } from "@/lib/db";
import { bookings, dossiers, extras, fees, icalBlocks, rooms } from "@/db/schema";
import {
  admitBooking,
  CapacityError,
  ExtraUnavailableError,
  FeeUnavailableError,
  priceStay,
  RoomUnavailableError,
  saveLines,
} from "@/lib/booking-intake";
import { admitRoomsInTx, createDossier, RoomRefused } from "@/lib/dossiers";
import { extraQuantitiesFrom, grandTotal, matchesRoom, type StayLine } from "@/lib/extras";
import { getBookingLines } from "@/lib/queries/extras";
import { bookingManualSchema, frDateToIso, isStayTooLong, isUuid, manualMoreRoomsSchema, safeParseFormData } from "@/lib/validation";
import { sendBookingModification } from "@/lib/email";
import { notifyHostCancellation } from "@/lib/dossier-cancellation";
import { loadEditableBooking, loadEmailContext, type BookingStatus } from "@/lib/queries/bookings";
import { dossierSizes } from "@/lib/queries/dossiers";

async function requireTenantId() {
  const { tenantId } = await requireSession();
  return tenantId;
}

// Transitions légales (cf. CONTEXT.md > Booking status) :
//   pending   → confirmed | cancelled
//   confirmed → completed (automatique après le départ : completeFinishedStays) | cancelled
//   completed, cancelled = terminaux
// La mise à jour est conditionnée à l'état de départ autorisé : un saut illégal
// (ou un double-clic / page périmée) n'affecte aucune ligne. Retourne `true` si
// une transition a réellement eu lieu.
async function updateStatus(
  id: string,
  tenantId: string,
  status: BookingStatus,
  allowedFrom: BookingStatus[],
): Promise<boolean> {
  const transitioned = await db
    .update(bookings)
    .set({ status, updatedAt: new Date() })
    .where(
      and(
        eq(bookings.id, id),
        eq(bookings.tenantId, tenantId),
        inArray(bookings.status, allowedFrom),
      ),
    )
    .returning({ id: bookings.id });

  if (transitioned.length === 0) return false;

  revalidatePath("/admin");
  revalidatePath("/admin/reservations");
  revalidatePath("/admin/calendrier");
  revalidatePath(`/admin/reservations/${id}`);
  return true;
}

export async function confirmBooking(id: string) {
  const tenantId = await requireTenantId();
  await updateStatus(id, tenantId, "confirmed", ["pending"]);
}

export async function cancelBooking(id: string) {
  const { session, tenantId } = await requireSession();
  const [before] = await db
    .select({ status: bookings.status, dossierId: bookings.dossierId })
    .from(bookings)
    .where(and(eq(bookings.id, id), eq(bookings.tenantId, tenantId)));
  const transitioned = await updateStatus(id, tenantId, "cancelled", [
    "pending",
    "confirmed",
  ]);

  // N'envoyer l'email d'annulation que si l'annulation a réellement eu lieu
  // (évite un second email si le booking était déjà annulé ou terminé).
  if (!transitioned || !before) return;
  captureServer(
    "booking_cancelled",
    { surface: "admin", tenant_id: tenantId, from_status: before.status },
    session.user.id,
  );
  revalidatePath(`/admin/dossiers/${before.dossierId}`);

  // Email au client (best-effort) ; l'hôte est prévenu s'il n'est pas parti, pour
  // qu'il contacte le client lui-même. Une chambre d'un Dossier = annulation partielle.
  const emailSent = await notifyHostCancellation(tenantId, before.dossierId, [id]);
  redirect(`/admin/reservations/${id}?annulee=${emailSent ? "1" : "sans-email"}`);
}

/** Annule les réservations actives (pending|confirmed) d'un Dossier du tenant ; `only` = une chambre. */
async function cancelInDossier(dossierId: string, tenantId: string, only?: string) {
  const rows = await db
    .update(bookings)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(
      and(
        eq(bookings.dossierId, dossierId),
        eq(bookings.tenantId, tenantId),
        inArray(bookings.status, ["pending", "confirmed"]),
        only ? eq(bookings.id, only) : undefined,
      ),
    )
    .returning({ id: bookings.id });
  if (rows.length === 0) return [];
  revalidatePath("/admin");
  revalidatePath("/admin/reservations");
  revalidatePath("/admin/calendrier");
  revalidatePath(`/admin/dossiers/${dossierId}`);
  for (const r of rows) revalidatePath(`/admin/reservations/${r.id}`);
  return rows.map((r) => r.id);
}

/**
 * Annuler UNE chambre d'un Dossier depuis sa fiche (ADR-0012) : les autres restent,
 * la chambre est libérée. Pas de remboursement automatique (la fiche dit combien rendre).
 */
export async function cancelDossierBooking(dossierId: string, bookingId: string) {
  const { session, tenantId } = await requireSession();
  if (!isUuid(dossierId) || !isUuid(bookingId)) return;
  const cancelled = await cancelInDossier(dossierId, tenantId, bookingId);
  if (cancelled.length === 0) return;
  captureServer("booking_cancelled", { surface: "admin", tenant_id: tenantId, scope: "room" }, session.user.id);
  const emailSent = await notifyHostCancellation(tenantId, dossierId, cancelled);
  redirect(`/admin/dossiers/${dossierId}?chambre-annulee=${emailSent ? "1" : "sans-email"}`);
}

/** Annuler tout le Dossier : chaque chambre encore active passe `cancelled` (transitions gardées). */
export async function cancelDossier(dossierId: string) {
  const { session, tenantId } = await requireSession();
  if (!isUuid(dossierId)) return;
  const cancelled = await cancelInDossier(dossierId, tenantId);
  if (cancelled.length === 0) return;
  captureServer(
    "booking_cancelled",
    { surface: "admin", tenant_id: tenantId, scope: "dossier", rooms: cancelled.length },
    session.user.id,
  );
  const emailSent = await notifyHostCancellation(tenantId, dossierId, cancelled);
  redirect(`/admin/dossiers/${dossierId}?annule=${emailSent ? "1" : "sans-email"}`);
}

/** Règlement hors ligne de tout le Dossier : chaque chambre non annulée (voir `setBookingPaid`). */
export async function setDossierPaid(dossierId: string, paid: boolean) {
  const tenantId = await requireTenantId();
  if (!isUuid(dossierId)) return;
  const rows = await db
    .update(bookings)
    .set({ paidAt: paid ? new Date() : null, updatedAt: new Date() })
    .where(
      and(
        eq(bookings.dossierId, dossierId),
        eq(bookings.tenantId, tenantId),
        inArray(bookings.status, ["pending", "confirmed", "completed"]),
      ),
    )
    .returning({ id: bookings.id });
  revalidatePath(`/admin/dossiers/${dossierId}`);
  revalidatePath("/admin/reservations");
  for (const r of rows) revalidatePath(`/admin/reservations/${r.id}`);
}

/**
 * Règlement hors ligne (virement, chèque, espèces) : l'hôte le note lui-même.
 * Annulable (`paid = false`) tant que la réservation n'est pas annulée.
 */
export async function setBookingPaid(id: string, paid: boolean) {
  const tenantId = await requireTenantId();
  await db
    .update(bookings)
    .set({ paidAt: paid ? new Date() : null, updatedAt: new Date() })
    .where(
      and(
        eq(bookings.id, id),
        eq(bookings.tenantId, tenantId),
        inArray(bookings.status, ["pending", "confirmed", "completed"]),
      ),
    );
  revalidatePath(`/admin/reservations/${id}`);
  revalidatePath("/admin/reservations");
}

/**
 * Devis pour le formulaire manuel : même calcul que l'enregistrement (`priceStay`),
 * donc le total affiché avant d'enregistrer est celui qui sera enregistré.
 * `null` tant que la saisie ne décrit pas un séjour valide.
 * `bookingId` (modification) : ses lignes gardent leur prix figé.
 */
export async function quoteManualBooking(input: {
  roomId: string;
  checkIn: string;
  checkOut: string;
  guestCount: string;
  childCount: string;
  extraIds: string[];
  extraQuantities?: Record<string, number>;
  feeIds: string[];
  waiveTax: boolean;
  agreedPrice: string;
  keepPrice: boolean;
  bookingId?: string;
}): Promise<{ nights: number; computed: number; accommodation: number; lines: StayLine[]; total: number } | null> {
  const tenantId = await requireTenantId();
  const { roomId, bookingId } = input;
  if (!isUuid(roomId) || (bookingId && !isUuid(bookingId))) return null;
  const from = new Date(frDateToIso(input.checkIn) + "T00:00:00.000Z");
  const to = new Date(frDateToIso(input.checkOut) + "T00:00:00.000Z");
  if (isNaN(from.getTime()) || isNaN(to.getTime()) || to <= from) return null;
  if (isStayTooLong(from, to)) return null;
  const guests = Math.max(1, Math.floor(Number(input.guestCount)) || 1);
  const children = Math.min(guests, Math.max(0, Math.floor(Number(input.childCount)) || 0));
  const [room, booking] = await Promise.all([
    db.query.rooms.findFirst({
      where: and(eq(rooms.id, roomId), eq(rooms.tenantId, tenantId)),
      columns: { id: true },
    }),
    // Lignes figées lues seulement sur une réservation de CE tenant.
    bookingId
      ? db.query.bookings.findFirst({
          where: and(eq(bookings.id, bookingId), eq(bookings.tenantId, tenantId)),
          columns: { id: true, totalPrice: true },
        })
      : undefined,
  ]);
  if (!room || (bookingId && !booking)) return null;
  const agreedPrice = /^\d+([.,]\d{1,2})?$/.test(input.agreedPrice.trim()) ? agreed(input.agreedPrice.trim()) : undefined;
  const accommodation =
    agreedPrice ?? (booking && input.keepPrice ? await oldAccommodation(booking.id, booking.totalPrice) : undefined);
  try {
    const price = await priceStay(db, {
      roomId,
      tenantId,
      checkIn: from,
      checkOut: to,
      guestCount: guests,
      childCount: children,
      extraIds: input.extraIds,
      extraQuantities: input.extraQuantities,
      feeIds: input.feeIds,
      waiveTax: input.waiveTax,
      accommodation,
      bookingId,
    });
    return {
      nights: price.breakdown.nights.length,
      computed: price.breakdown.totalPrice,
      accommodation: price.accommodation,
      lines: price.lines,
      total: price.total,
    };
  } catch (e) {
    if (e instanceof ExtraUnavailableError || e instanceof FeeUnavailableError) return null;
    throw e;
  }
}

/** Ancien total moins toutes ses lignes : ce que « Garder l'ancien prix » conserve. */
async function oldAccommodation(bookingId: string, totalPrice: string) {
  return parseFloat(totalPrice) - grandTotal(0, await getBookingLines(bookingId));
}

/** Cases cochées d'un nom répété (formEntries ne garde que la dernière valeur). */
function formIds(formData: FormData, name: "extraIds" | "feeIds"): string[] {
  return formData.getAll(name).filter((v): v is string => typeof v === "string");
}

/** Prix convenu saisi (hébergement seul, ADR-0010) en nombre. */
const agreed = (s: string) => parseFloat(s.replace(",", "."));

export type ManualBookingState = {
  error: string;
  /** Erreur par champ (aria-invalid + message sous le libellé). */
  fieldErrors?: Record<string, string>;
  /** Les dates chevauchent un Hold : le formulaire propose alors « Forcer ». */
  conflict?: boolean;
  /** Ce qui bloque, pour dire à l'hôte ce que « Forcer » implique. */
  clash?: { kind: "booking"; guestName: string } | { kind: "ical" } | { kind: "manual" };
  /** Valeurs saisies, pour ne pas vider le formulaire après une erreur. */
  values: Record<string, string>;
} | null;

export async function createBookingManual(
  _prev: ManualBookingState,
  formData: FormData,
): Promise<ManualBookingState> {
  const tenantId = await requireTenantId();
  const values: Record<string, string> = {};
  for (const [k, v] of formData.entries()) if (typeof v === "string") values[k] = v;

  const parsed = safeParseFormData(bookingManualSchema, formData);
  if ("error" in parsed) return { ...parsed, values };
  const { data } = parsed;
  const { roomId, guestEmail, guestCount, childCount, guestFirstName, guestLastName } = data;
  const guestName = fullName(guestFirstName, guestLastName);
  const guestPhone = data.guestPhone || null;
  const checkIn = new Date(data.checkIn + "T00:00:00.000Z");
  const checkOut = new Date(data.checkOut + "T00:00:00.000Z");
  const notes = data.notes || null;

  // Plusieurs chambres : un Dossier (ADR-0012), mêmes dates et même voyageur.
  const more = manualMoreRoomsSchema.safeParse(formData.get("moreRooms"));
  if (!more.success) {
    return { error: more.error.issues[0]?.message ?? "Chambres supplémentaires invalides", values };
  }
  if (more.data.length > 0) {
    return createDossierManual(formData, values, data, more.data);
  }

  // Admission : résout+autorise la chambre, calcule le prix et insère sous verrou.
  // Les booking-rules ne s'appliquent pas au manuel ; la dispo est contrôlée sauf
  // override (« Forcer »).
  let bookingId: string;
  try {
    bookingId = await admitBooking(
      {
        roomId,
        tenantId,
        checkIn,
        checkOut,
        guestCount,
        childCount,
        extraIds: formIds(formData, "extraIds"),
        extraQuantities: extraQuantitiesFrom(formData.entries()),
        feeIds: formIds(formData, "feeIds"),
        waiveTax: data.waiveTax,
        // Prix convenu avec le client (téléphone, fidèle…) = hébergement seul ; les lignes s'y ajoutent.
        accommodation: data.agreedPrice ? agreed(data.agreedPrice) : undefined,
      },
      { allowOverlap: data.force },
      async (tx, { lines, total }) => {
        const guest = { guestName, guestFirstName, guestLastName, guestEmail, guestPhone };
        const dossierId = await createDossier(tx, { tenantId, checkIn, checkOut, ...guest });
        const [row] = await tx
          .insert(bookings)
          .values({
            tenantId,
            dossierId,
            roomId,
            checkIn,
            checkOut,
            totalPrice: total.toFixed(2),
            ...guest,
            guestCount,
            childCount,
            notes,
            status: "confirmed",
            source: "manual",
          })
          .returning({ id: bookings.id });
        await saveLines(tx, row.id, lines);
        return row.id;
      },
    );
  } catch (e) {
    const state = await admissionErrorState(e, { tenantId, roomId, checkIn, checkOut }, values);
    if (state) return state;
    throw e;
  }

  revalidatePath("/admin/reservations");
  revalidatePath("/admin/calendrier");
  redirect(`/admin/reservations/${bookingId}?enregistree=1`);
}

type ManualData = Extract<ReturnType<typeof bookingManualSchema.safeParse>, { success: true }>["data"];
type MoreRoom = { roomId: string; guestCount: number; childCount: number };

/**
 * Saisie manuelle d'un Dossier de plusieurs chambres (mêmes dates, même voyageur).
 * Même gate que la chambre seule (ADR-0008), chaque chambre admise dans UNE transaction,
 * tout ou rien ; « Forcer » vaut pour toutes les chambres. Options et frais cochés
 * s'appliquent à chaque chambre qui les propose. Pas de prix convenu (par chambre,
 * via « Modifier » ensuite).
 */
async function createDossierManual(
  formData: FormData,
  values: Record<string, string>,
  data: ManualData,
  more: MoreRoom[],
): Promise<ManualBookingState> {
  const tenantId = await requireTenantId();
  const plan: MoreRoom[] = [{ roomId: data.roomId, guestCount: data.guestCount, childCount: data.childCount }, ...more];
  if (new Set(plan.map((p) => p.roomId)).size !== plan.length) {
    return { error: "La même chambre est choisie deux fois.", values };
  }
  if (data.agreedPrice) {
    return {
      error: "Le prix convenu ne vaut que pour une chambre seule : enregistrez, puis modifiez le prix de chaque chambre.",
      fieldErrors: { agreedPrice: "Une chambre seule" },
      values,
    };
  }
  const checkIn = new Date(data.checkIn + "T00:00:00.000Z");
  const checkOut = new Date(data.checkOut + "T00:00:00.000Z");
  const guest = {
    guestName: fullName(data.guestFirstName, data.guestLastName),
    guestFirstName: data.guestFirstName,
    guestLastName: data.guestLastName,
    guestEmail: data.guestEmail,
    guestPhone: data.guestPhone || null,
  };
  // Options et frais réservés à certaines chambres : chaque chambre ne reçoit que les siens.
  // Un id inconnu passe tel quel : le gate le refuse (ExtraUnavailableError / FeeUnavailableError).
  const [extraScopes, feeScopes, roomNames] = await Promise.all([
    db.select({ id: extras.id, roomIds: extras.roomIds }).from(extras).where(eq(extras.tenantId, tenantId)),
    db.select({ id: fees.id, roomIds: fees.roomIds }).from(fees).where(eq(fees.tenantId, tenantId)),
    db
      .select({ id: rooms.id, name: rooms.name })
      .from(rooms)
      .where(and(eq(rooms.tenantId, tenantId), inArray(rooms.id, plan.map((p) => p.roomId)))),
  ]);
  const forRoom = (ids: string[], scopes: { id: string; roomIds: string[] }[], roomId: string) =>
    ids.filter((id) => {
      const scope = scopes.find((x) => x.id === id);
      return !scope || matchesRoom(scope, roomId);
    });
  const extraIds = formIds(formData, "extraIds");
  const feeIds = formIds(formData, "feeIds");
  const extraQuantities = extraQuantitiesFrom(formData.entries());

  let dossierId: string;
  try {
    dossierId = await db.transaction(async (tx) => {
      const admitted = await admitRoomsInTx(
        tx,
        plan,
        (p) => ({
          roomId: p.roomId,
          tenantId,
          checkIn,
          checkOut,
          guestCount: p.guestCount,
          childCount: p.childCount,
          extraIds: forRoom(extraIds, extraScopes, p.roomId),
          extraQuantities,
          feeIds: forRoom(feeIds, feeScopes, p.roomId),
          waiveTax: data.waiveTax,
        }),
        { allowOverlap: data.force },
      );
      const id = await createDossier(tx, { tenantId, checkIn, checkOut, ...guest });
      for (const p of plan) {
        const { lines, total } = admitted.get(p.roomId)!;
        const [row] = await tx
          .insert(bookings)
          .values({
            tenantId,
            dossierId: id,
            roomId: p.roomId,
            checkIn,
            checkOut,
            totalPrice: total.toFixed(2),
            ...guest,
            guestCount: p.guestCount,
            childCount: p.childCount,
            notes: data.notes || null,
            status: "confirmed",
            source: "manual",
          })
          .returning({ id: bookings.id });
        await saveLines(tx, row.id, lines);
      }
      return id;
    });
  } catch (e) {
    if (!(e instanceof RoomRefused)) throw e;
    const state = await admissionErrorState(e.reason, { tenantId, roomId: e.roomId, checkIn, checkOut }, values);
    if (!state) throw e.reason;
    // Nommer la chambre refusée : l'hôte en a saisi plusieurs.
    const name = roomNames.find((r) => r.id === e.roomId)?.name;
    const index = plan.findIndex((p) => p.roomId === e.roomId);
    const fieldErrors = { ...state.fieldErrors };
    for (const key of ["guestCount", "roomId"] as const) {
      if (index > 0 && fieldErrors[key]) {
        fieldErrors[`more${key[0].toUpperCase()}${key.slice(1)}_${index - 1}`] = fieldErrors[key];
        delete fieldErrors[key];
      }
    }
    return { ...state, error: name ? `${name} : ${state.error}` : state.error, fieldErrors };
  }

  revalidatePath("/admin/reservations");
  revalidatePath("/admin/calendrier");
  redirect(`/admin/dossiers/${dossierId}?enregistre=1`);
}

/**
 * Refus d'admission traduit pour le formulaire manuel (création ou modification) ;
 * null si l'erreur n'est pas un refus attendu.
 */
async function admissionErrorState(
  e: unknown,
  stay: { tenantId: string; roomId: string; checkIn: Date; checkOut: Date; excludeBookingId?: string },
  values: Record<string, string>,
): Promise<ManualBookingState> {
  const { tenantId, roomId, checkIn, checkOut, excludeBookingId } = stay;
  if (e instanceof RoomUnavailableError) {
    // Nommer ce qui bloque : l'hôte décide de forcer en connaissance de cause.
    const clash = await db.query.bookings.findFirst({
      where: and(
        eq(bookings.tenantId, tenantId),
        eq(bookings.roomId, roomId),
        inArray(bookings.status, ["pending", "confirmed"]),
        lt(bookings.checkIn, checkOut),
        gt(bookings.checkOut, checkIn),
        excludeBookingId ? ne(bookings.id, excludeBookingId) : undefined,
      ),
      columns: { guestName: true, checkIn: true, checkOut: true },
    });
    const day = (d: Date) =>
      new Date(d).toLocaleDateString("fr-FR", { day: "numeric", month: "long", timeZone: "UTC" });
    if (clash) {
      return {
        error: `Ces dates chevauchent le séjour de ${clash.guestName} (du ${day(clash.checkIn)} au ${day(clash.checkOut)}).`,
        conflict: true,
        clash: { kind: "booking", guestName: clash.guestName },
        values,
      };
    }
    // Pas de séjour : un import Airbnb/Booking (vraie double vente) ou un blocage posé par l'hôte.
    const ical = await db.query.icalBlocks.findFirst({
      where: and(
        eq(icalBlocks.tenantId, tenantId),
        eq(icalBlocks.roomId, roomId),
        lt(icalBlocks.start, checkOut),
        gt(icalBlocks.end, checkIn),
      ),
      columns: { id: true },
    });
    return {
      error: ical
        ? "Ces dates chevauchent une réservation Airbnb ou Booking (calendrier synchronisé)."
        : "Ces dates chevauchent un blocage que vous avez posé sur cette chambre.",
      conflict: true,
      clash: { kind: ical ? "ical" : "manual" },
      values,
    };
  }
  if (e instanceof CapacityError) {
    return { error: e.message, fieldErrors: { guestCount: e.message }, values };
  }
  if (e instanceof ExtraUnavailableError) {
    return { error: "Une option cochée vient d'être désactivée ou supprimée, ou n'est pas proposée pour cette chambre. Rechargez la page.", values };
  }
  if (e instanceof FeeUnavailableError) {
    return { error: e.message, values };
  }
  if (e instanceof Error && e.message === "Chambre introuvable") {
    return {
      error: "Cette chambre n'existe plus ou est désactivée.",
      fieldErrors: { roomId: "Chambre indisponible" },
      values,
    };
  }
  return null;
}

/**
 * Modification d'un séjour par l'hôte (dates, chambre, client). Même admission que
 * la saisie manuelle, sans que le séjour se bloque lui-même ; statut, paiement et
 * origine ne bougent pas. Jamais d'email d'annulation : au plus un email « modifié ».
 */
export async function updateBookingManual(
  id: string,
  _prev: ManualBookingState,
  formData: FormData,
): Promise<ManualBookingState> {
  const tenantId = await requireTenantId();
  const values: Record<string, string> = {};
  for (const [k, v] of formData.entries()) if (typeof v === "string") values[k] = v;

  const editable = await loadEditableBooking(id, tenantId);
  if (!editable) {
    return {
      error: "Cette réservation ne peut plus être modifiée : elle est terminée, annulée ou en cours de paiement en ligne.",
      values,
    };
  }

  const parsed = safeParseFormData(bookingManualSchema, formData);
  if ("error" in parsed) return { ...parsed, values };
  const { data } = parsed;
  const { roomId, guestEmail, guestCount, childCount, guestFirstName, guestLastName } = data;
  const guestName = fullName(guestFirstName, guestLastName);
  const checkIn = new Date(data.checkIn + "T00:00:00.000Z");
  const checkOut = new Date(data.checkOut + "T00:00:00.000Z");
  // Dossier de plusieurs chambres (ADR-0012, v1) : toutes les chambres gardent les mêmes dates.
  // Une chambre ne s'en écarte pas seule ; le voyageur, lui, vaut pour tout le Dossier.
  const dossierSize = (await dossierSizes(tenantId, [editable.booking.dossierId])).get(editable.booking.dossierId) ?? 1;
  if (
    dossierSize > 1 &&
    (checkIn.getTime() !== new Date(editable.booking.checkIn).getTime() ||
      checkOut.getTime() !== new Date(editable.booking.checkOut).getTime())
  ) {
    const message = `Les ${dossierSize} chambres de ce Dossier ont les mêmes dates : elles ne se changent pas pour une seule chambre. Annulez cette chambre et saisissez-la à nouveau, ou annulez le Dossier.`;
    return { error: message, fieldErrors: { checkIn: "Dates du Dossier" }, values };
  }
  // Hébergement : prix convenu saisi > ancien hébergement gardé > nouveau calcul ; les Extras s'y ajoutent.
  const keepPrice = formData.get("keepPrice") === "on";
  const notifyGuest = formData.get("notifyGuest") === "on";

  try {
    await admitBooking(
      {
        roomId,
        tenantId,
        checkIn,
        checkOut,
        guestCount,
        childCount,
        extraIds: formIds(formData, "extraIds"),
        extraQuantities: extraQuantitiesFrom(formData.entries()),
        feeIds: formIds(formData, "feeIds"),
        waiveTax: data.waiveTax,
        accommodation: data.agreedPrice
          ? agreed(data.agreedPrice)
          : keepPrice
            ? await oldAccommodation(id, editable.booking.totalPrice)
            : undefined,
      },
      { allowOverlap: data.force, excludeBookingId: id },
      async (tx, { lines, total }) => {
        const updated = await tx
          .update(bookings)
          .set({
            roomId,
            checkIn,
            checkOut,
            totalPrice: total.toFixed(2),
            guestName,
            guestFirstName,
            guestLastName,
            guestEmail,
            guestPhone: data.guestPhone || null,
            guestCount,
            childCount,
            notes: data.notes || null,
            updatedAt: new Date(),
          })
          // Re-vérifié sous verrou : annulée ou terminée entre-temps → rien n'est écrit.
          .where(
            and(
              eq(bookings.id, id),
              eq(bookings.tenantId, tenantId),
              inArray(bookings.status, ["pending", "confirmed"]),
            ),
          )
          .returning({ dossierId: bookings.dossierId });
        if (updated.length === 0) throw new BookingNoLongerEditableError();
        // Le Dossier suit (dates : identiques pour toutes ses chambres, vérifié plus haut).
        // Le voyageur est celui de tout le Dossier : ses autres réservations le reprennent.
        const { dossierId } = updated[0];
        const guest = { guestName, guestFirstName, guestLastName, guestEmail, guestPhone: data.guestPhone || null };
        await tx
          .update(dossiers)
          .set({ checkIn, checkOut, ...guest, updatedAt: new Date() })
          .where(and(eq(dossiers.id, dossierId), eq(dossiers.tenantId, tenantId)));
        await tx
          .update(bookings)
          .set({ ...guest, updatedAt: new Date() })
          .where(and(eq(bookings.dossierId, dossierId), eq(bookings.tenantId, tenantId), ne(bookings.id, id)));
        await saveLines(tx, id, lines);
      },
    );
  } catch (e) {
    if (e instanceof BookingNoLongerEditableError) {
      return { error: "Cette réservation vient d'être annulée ou terminée : elle ne peut plus être modifiée.", values };
    }
    const state = await admissionErrorState(e, { tenantId, roomId, checkIn, checkOut, excludeBookingId: id }, values);
    if (state) return state;
    throw e;
  }

  revalidatePath("/admin/reservations");
  revalidatePath(`/admin/reservations/${id}`);
  revalidatePath("/admin/calendrier");

  let outcome = "silence";
  if (notifyGuest) {
    outcome = "sans-email";
    try {
      const ctx = await loadEmailContext(id, tenantId);
      if (ctx) {
        await sendBookingModification(ctx.emailData);
        outcome = "1";
      }
    } catch (emailError) {
      console.error("Erreur envoi email modification:", emailError);
    }
  }
  redirect(`/admin/reservations/${id}?modifiee=${outcome}`);
}

class BookingNoLongerEditableError extends Error {}
