/**
 * Sonde de `network.spec.ts` : appelle `findVoisins` (lib/network.ts) sur la base de test.
 * Usage : tsx network-probe.ts <originTenantId> <checkIn> <checkOut> <adults> <minors>
 * Imprime le JSON du résultat.
 */
const [origin, checkIn, checkOut, adults, minors] = process.argv.slice(2);
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
export {};

async function main() {
  const { findVoisins } = await import("../../lib/network");
  const out = await findVoisins({
    originTenantId: origin,
    checkIn: new Date(`${checkIn}T00:00:00Z`),
    checkOut: new Date(`${checkOut}T00:00:00Z`),
    adults: Number(adults),
    minors: Number(minors),
  });
  console.log(JSON.stringify(out));
  process.exit(0);
}

main();
