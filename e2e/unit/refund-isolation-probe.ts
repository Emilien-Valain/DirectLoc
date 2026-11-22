/**
 * Sonde exécutée en sous-processus par `refund-isolation.spec.ts` (faux Stripe démarré par le
 * spec, STRIPE_API_BASE). Appelle `refundDossierPayment` / `checkRefund` (`lib/dossier-admin.ts`,
 * la logique qu'appellent les server actions après la session) au nom du tenant A.
 * Imprime en JSON le résultat de chaque appel : `{ ok: valeur }` ou `{ error: "Nom: message" }`.
 *
 * Usage : tsx refund-isolation-probe.ts <tenantA> <dossierA> <dossierB> <bookingB> <dossierOffline> <uuid>…
 *         tsx refund-isolation-probe.ts demo <tenant> <dossier> <uuid>   (remboursement + email voyageur)
 */
const [tenantA, dossierA, dossierB, bookingB, dossierOffline, ...ids] = process.argv.slice(2);
const demoMode = tenantA === "demo";
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
export {};

async function demo() {
  const [tenant, dossier, requestId] = [dossierA, dossierB, bookingB];
  const lib = await import("../../lib/dossier-admin");
  const { notifyGuestRefund } = await import("../../lib/refunds");
  const r = await lib.refundDossierPayment(tenant, dossier, { amountCents: 2500, requestId });
  const emailed = await notifyGuestRefund(tenant, dossier, r.amount);
  console.log(JSON.stringify({ status: r.status, created: r.created, emailed }));
  process.exit(0);
}

async function main() {
  if (demoMode) return demo();
  const lib = await import("../../lib/dossier-admin");
  const run = async (f: () => Promise<unknown>) => {
    try {
      return { ok: await f() };
    } catch (e) {
      const err = e as Error;
      return { error: `${err.name}: ${err.message}` };
    }
  };
  const strip = (r: { ok?: unknown; error?: string }) =>
    r.ok && typeof r.ok === "object" ? { ok: { ...(r.ok as object), id: "<id>" } } : r;
  const [k1, k2, k3, k4, k5, k6, k7] = ids;

  const out: Record<string, unknown> = {
    // Tenant A visant le Dossier du tenant B : introuvable, rien chez Stripe ni en base.
    rivalRefund: await run(() => lib.refundDossierPayment(tenantA, dossierB, { amountCents: 1000, requestId: k1 })),
    rivalCheck: await run(() => lib.checkRefund(tenantA, dossierB, 1000)),
    // Montants impossibles (forgés hors formulaire) : refusés avant Stripe.
    zero: await run(() => lib.refundDossierPayment(tenantA, dossierA, { amountCents: 0, requestId: k2 })),
    negative: await run(() => lib.refundDossierPayment(tenantA, dossierA, { amountCents: -500, requestId: k2 })),
    fractional: await run(() => lib.refundDossierPayment(tenantA, dossierA, { amountCents: 10.5, requestId: k2 })),
    tooMuch: await run(() => lib.refundDossierPayment(tenantA, dossierA, { amountCents: 21001, requestId: k2 })),
    badRequestId: await run(() => lib.refundDossierPayment(tenantA, dossierA, { amountCents: 100, requestId: "pas-un-uuid" })),
    // Réglé hors ligne : pas de paiement en ligne à rembourser.
    offline: await run(() => lib.refundDossierPayment(tenantA, dossierOffline, { amountCents: 100, requestId: k3 })),
    offlineCheck: await run(() => lib.checkRefund(tenantA, dossierOffline, 100)),
    // Une chambre d'un autre tenant passée en bookingId : ignorée (remboursement du Dossier seul).
    forgedBooking: strip(await run(() => lib.refundDossierPayment(tenantA, dossierA, { amountCents: 5000, requestId: k4, bookingId: bookingB, reason: "  Geste  " }))),
  };
  // Même soumission rejouée : le même remboursement, pas un second.
  const first = await run(() => lib.refundDossierPayment(tenantA, dossierA, { amountCents: 5000, requestId: k4 }));
  out.replay = strip(first);
  // Deux remboursements simultanés de 100 € alors qu'il reste 160 € : un seul passe (verrou du Dossier).
  const both = await Promise.all([
    run(() => lib.refundDossierPayment(tenantA, dossierA, { amountCents: 10000, requestId: k5 })),
    run(() => lib.refundDossierPayment(tenantA, dossierA, { amountCents: 10000, requestId: k6 })),
  ]);
  out.concurrent = both.map((r) => ("ok" in r ? "ok" : r.error));
  // Le reste exact (60 €) passe ; un centime de plus ensuite, non.
  out.rest = strip(await run(() => lib.refundDossierPayment(tenantA, dossierA, { amountCents: 6000, requestId: k7 })));
  out.afterFull = await run(() => lib.checkRefund(tenantA, dossierA, 1));
  console.log(JSON.stringify(out));
  process.exit(0);
}

main();
