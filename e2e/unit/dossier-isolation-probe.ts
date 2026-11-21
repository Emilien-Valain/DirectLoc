/**
 * Sonde exécutée en sous-processus par `dossier-isolation.spec.ts`. Appelle la logique
 * serveur des actions de la fiche Dossier (`lib/dossier-admin.ts`, celle qu'appellent les
 * server actions après la session) au nom du tenant A, sur un Dossier du tenant B.
 * Imprime en JSON le résultat de chaque appel : `{ ok: valeur }` ou `{ error: "Nom: message" }`.
 *
 * Usage : tsx dossier-isolation-probe.ts <tenantA> <dossierA> <roomA2> <dossierB> <bookingB> <roomB>
 */
const [tenantA, dossierA, roomA2, dossierB, bookingB, roomB] = process.argv.slice(2);
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
export {};

async function main() {
  const lib = await import("../../lib/dossier-admin");
  const run = async (f: () => Promise<unknown>) => {
    try {
      return { ok: await f() };
    } catch (e) {
      const err = e as Error & { reason?: Error };
      // RoomRefused : la vraie cause est l'erreur du gate.
      const cause = err.reason instanceof Error ? err.reason : err;
      return { error: `${cause.name}: ${cause.message}` };
    }
  };
  const dates = { checkIn: new Date("2036-03-10T00:00:00Z"), checkOut: new Date("2036-03-13T00:00:00Z") };

  const out = {
    // Tenant A visant le Dossier du tenant B : rien ne doit bouger chez B.
    cancelRoom: await run(() => lib.cancelDossierRooms(tenantA, dossierB, bookingB)),
    cancelAll: await run(() => lib.cancelDossierRooms(tenantA, dossierB)),
    markPaid: await run(() => lib.setDossierPaidState(tenantA, dossierB, true)),
    markUnpaid: await run(() => lib.setDossierPaidState(tenantA, dossierB, false)),
    changeDates: await run(() => lib.changeDossierDates(tenantA, dossierB, { ...dates, force: true })),
    addRoom: await run(() => lib.addRoomToDossier(tenantA, dossierB, { roomId: roomA2, guestCount: 1, force: true })),
    quote: await run(() => lib.quoteDossierDatesFor(tenantA, dossierB, dates.checkIn, dates.checkOut)),
    // La chambre du tenant B dans un Dossier du tenant A : refusée par le gate.
    addRivalRoom: await run(() => lib.addRoomToDossier(tenantA, dossierA, { roomId: roomB, guestCount: 1, force: true })),
    // Contrôle : les mêmes fonctions agissent bien sur le Dossier du tenant A.
    ownChangeDates: await run(() => lib.changeDossierDates(tenantA, dossierA, dates)),
    ownMarkPaid: await run(() => lib.setDossierPaidState(tenantA, dossierA, true)),
    ownCancelAll: await run(() => lib.cancelDossierRooms(tenantA, dossierA)),
    // Dossier annulé : plus rien ne se modifie.
    cancelledChangeDates: await run(() => lib.changeDossierDates(tenantA, dossierA, { checkIn: new Date("2036-03-20T00:00:00Z"), checkOut: new Date("2036-03-21T00:00:00Z") })),
    cancelledAddRoom: await run(() => lib.addRoomToDossier(tenantA, dossierA, { roomId: roomA2, guestCount: 1 })),
  };
  console.log(JSON.stringify(out));
  process.exit(0);
}

main();
