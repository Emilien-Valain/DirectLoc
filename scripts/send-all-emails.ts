/**
 * Envoie un exemplaire de chaque email de lib/email.ts à une adresse, avec des données fictives.
 * Usage : npx tsx --env-file=.env.local scripts/send-all-emails.ts <destinataire> [filtre-libellé]
 * (SMTP_* doit pointer vers un vrai serveur pour que ça arrive dans une boîte réelle.)
 */
import * as email from "@/lib/email";

const to = process.argv[2];
if (!to) throw new Error("Usage : send-all-emails.ts <email>");

const tenantId = "00000000-0000-0000-0000-000000000000";
const config = {
  primaryColor: "#7a3e2b",
  secondaryColor: "#f6efe6",
  address: "12 rue des Tilleuls, 24200 Sarlat",
  phone: "05 53 00 00 00",
  email: "contact@exemple.fr",
};
const checkIn = new Date(Date.UTC(2026, 11, 18));
const checkOut = new Date(Date.UTC(2026, 11, 21));
const extras = [{ label: "Petit-déjeuner", quantity: 2, unitPrice: 12, total: 24 }];
const roomA = {
  roomName: "Chambre Lavande",
  totalPrice: "294.00",
  extras,
  guestCount: 2,
  roomCapacity: 2,
  roomBeds: 1,
  roomInfo: { wifi: "Lavande-2026", code: "4812" },
  roomMessage: "Le code de la boîte à clés est {code}. Wifi : {wifi}.",
};
const roomB = { roomName: "Suite Tilleul", totalPrice: "420.00", guestCount: 3, roomCapacity: 4, roomBeds: 2 };
const base = {
  guestName: "Emilien Valain",
  guestFirstName: "Emilien",
  guestEmail: to,
  checkIn,
  checkOut,
  nights: 3,
  hotelName: "La Maison des Tilleuls",
  config,
  tenantId,
};
const single = { ...base, rooms: [roomA], totalPrice: "294.00" };
const multi = { ...base, rooms: [roomA, roomB], totalPrice: "714.00" };
const booking = { ...base, ...roomA };

const sends: [string, () => Promise<unknown>][] = [
  ["Confirmation (1 chambre)", () => email.sendBookingConfirmation({ ...single, confirmationMessage: "Bonjour {prenom}, à bientôt !" })],
  ["Confirmation (2 chambres)", () => email.sendBookingConfirmation(multi)],
  ["Modification (ancienne, 1 chambre)", () => email.sendBookingModification(booking)],
  ["Modification dossier", () => email.sendDossierModification(multi)],
  ["Notification admin", () => email.sendAdminNotification({ ...multi, guestPhone: "06 12 34 56 78", adminEmail: to })],
  ["Alerte payé après annulation", () => email.sendPaidAfterCancellationAlert({ ...booking, adminEmail: to, stripePaymentId: "pi_test_123", cancelledRooms: [{ name: "Suite Tilleul", total: "420.00" }] })],
  ["Annulation (admin)", () => email.sendBookingCancellation({ ...base, roomNames: ["Chambre Lavande", "Suite Tilleul"], reason: "admin" })],
  ["Annulation (paiement expiré)", () => email.sendBookingCancellation({ ...base, roomNames: ["Chambre Lavande"], reason: "payment_expired" })],
  ["Annulation partielle", () => email.sendPartialCancellation({ ...base, cancelledRooms: [{ name: "Suite Tilleul", total: "420.00" }], keptRooms: [{ name: "Chambre Lavande", total: "294.00" }], newTotal: "294.00" })],
  ["Rappel avant arrivée", () => email.sendCheckInReminder({ ...multi, daysUntil: 3 })],
  ["Merci après séjour", () => email.sendPostStayThankYou(single)],
  ["Mot de passe oublié", () => email.sendPasswordResetEmail({ userName: "Emilien", userEmail: to, resetUrl: "https://directloc.app/reset?token=exemple", hotelName: base.hotelName, config, tenantId })],
  ["Demande de rappel (vitrine)", () => { process.env.OPERATOR_EMAIL = to; return email.sendCallbackRequest({ name: "Jean Test", phone: "06 00 00 00 00", place: "Gîte du Moulin, Sarlat", ref: "partenaire-x" }); }],
];

(async () => {
const only = process.argv[3]; // filtre optionnel sur le libellé, ex. "Modification"
for (const [label, send] of sends.filter(([l]) => !only || l.includes(only))) {
  try {
    await send();
    console.log("✓", label);
  } catch (e) {
    console.log("✗", label, "—", (e as Error).message);
  }
}
process.exit(0);
})();
