/**
 * Sonde exécutée en sous-processus par `dispute-isolation.spec.ts` (faux Stripe démarré par le spec,
 * STRIPE_API_BASE). Appelle `saveDisputeEvidence` / `acceptDispute` (`lib/disputes.ts`, la logique
 * qu'appellent les server actions après la session) au nom du tenant A.
 * Imprime en JSON le résultat de chaque appel : `{ ok: valeur }` ou `{ error: "Nom: message" }`.
 *
 * Usage : tsx dispute-isolation-probe.ts <tenantA> <disputeA> <disputeB> <disputeAccept> <disputePastDue>
 *         tsx dispute-isolation-probe.ts demo <tenant> <dispute>
 */
const [tenantA, disputeA, disputeB, disputeAccept, disputePastDue] = process.argv.slice(2);
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
export {};

async function main() {
  const lib = await import("../../lib/disputes");
  const run = async (f: () => Promise<unknown>) => {
    try {
      return { ok: await f() };
    } catch (e) {
      const err = e as Error;
      return { error: `${err.name}: ${err.message}` };
    }
  };
  if (tenantA === "demo") {
    const out = await run(() => lib.saveDisputeEvidence(disputeA, disputeB, { customer_name: "Démo" }, false));
    console.log(JSON.stringify(out));
    process.exit(0);
  }
  const out: Record<string, unknown> = {
    // Tenant A visant le litige du tenant B : introuvable, rien chez Stripe ni en base.
    rivalDraft: await run(() => lib.saveDisputeEvidence(tenantA, disputeB, { customer_name: "Pirate" }, false)),
    rivalSubmit: await run(() => lib.saveDisputeEvidence(tenantA, disputeB, { customer_name: "Pirate" }, true)),
    rivalAccept: await run(() => lib.acceptDispute(tenantA, disputeB)),
    rivalRead: (await lib.getDisputeForAdmin(tenantA, disputeB)) ?? null,
    badId: await run(() => lib.acceptDispute(tenantA, "pas-un-uuid")),
    // Champs inconnus (fichiers Stripe) ignorés.
    draft: await run(() =>
      lib.saveDisputeEvidence(tenantA, disputeA, { customer_name: "  Jeanne  ", receipt: "file_x", uncategorized_text: "Note" }, false),
    ),
  };
  // Deux envois simultanés : un seul passe (verrou), le second est refusé.
  const both = await Promise.all([
    run(() => lib.saveDisputeEvidence(tenantA, disputeA, { customer_name: "Jeanne" }, true)),
    run(() => lib.saveDisputeEvidence(tenantA, disputeA, { customer_name: "Jeanne" }, true)),
  ]);
  out.concurrent = both.map((r) => ("ok" in r ? "ok" : r.error));
  out.afterSubmitDraft = await run(() => lib.saveDisputeEvidence(tenantA, disputeA, { customer_name: "X" }, false));
  out.afterSubmitAccept = await run(() => lib.acceptDispute(tenantA, disputeA));
  out.accept = await run(() => lib.acceptDispute(tenantA, disputeAccept));
  out.acceptAgain = await run(() => lib.acceptDispute(tenantA, disputeAccept));
  out.pastDue = await run(() => lib.saveDisputeEvidence(tenantA, disputePastDue, { customer_name: "X" }, true));
  console.log(JSON.stringify(out));
  process.exit(0);
}

main();
