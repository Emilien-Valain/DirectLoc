import type { Pool } from "pg";

/**
 * Activité réseau fabriquée autour de test-tenant (compteur du tableau de bord, issue reseau-voisins/05).
 * Deux tenants satellites (P = voisin, Q = tiers sans lien avec test-tenant) ; tout est supprimé par `cleanup`.
 * Contribution à test-tenant, ce mois-ci : 2 envoyés, 1 reçu, 2 réservations (1 reçue + 1 envoyée, confirmées) ;
 * le mois précédent : 1 envoyé. Bruit qui ne doit PAS compter : Renvois Q↔P, Dossier attribué en attente, Dossier non attribué.
 */
export const EXPECTED = { month: { sent: 2, received: 1, bookings: 2 }, previous: { sent: 1, received: 0 } };

export async function seedNetworkActivity(pool: Pool, ctx: { tenantId: string; apiRoomId: string }) {
  const s = Math.random().toString(36).slice(2, 8);
  const mk = async (key: string) => {
    const { rows } = await pool.query(
      `INSERT INTO tenants (slug, name, domain, config) VALUES ($1, $2, $3, $4::jsonb) RETURNING id`,
      [`na-${key}-${s}`, `Satellite ${key} ${s}`, `na-${key}-${s}.example.test`, JSON.stringify({ latitude: 21, longitude: 21 })],
    );
    const { rows: [prop] } = await pool.query("INSERT INTO properties (tenant_id, name) VALUES ($1, 'Maison') RETURNING id", [rows[0].id]);
    const r = await pool.query(
      `INSERT INTO rooms (tenant_id, property_id, name, slug, price_per_night, capacity) VALUES ($1, $2, 'Chambre', 'ch-1', '90.00', 2) RETURNING id`,
      [rows[0].id, prop.id],
    );
    return { id: rows[0].id as string, roomId: r.rows[0].id as string };
  };
  const P = await mk("p");
  const Q = await mk("q");
  const T = ctx.tenantId;

  const ref = (from: string, to: string, when: string) =>
    pool.query(
      `INSERT INTO referrals (from_tenant_id, to_tenant_id, check_in, check_out, guest_count, kind, created_at)
       VALUES ($1, $2, '2036-03-01', '2036-03-04', 2, 'full', ${when})`,
      [from, to],
    );
  const NOW = "(now() at time zone 'utc')";
  const PREV = "(date_trunc('month', now() at time zone 'utc') - interval '10 days')";
  await ref(T, P.id, NOW);
  await ref(T, P.id, NOW);
  await ref(P.id, T, NOW);
  await ref(T, P.id, PREV);
  await ref(Q.id, P.id, NOW);
  await ref(P.id, Q.id, NOW);

  const dossier = async (tenant: string, room: string, referredBy: string | null, status: string) => {
    const { rows: [d] } = await pool.query(
      `INSERT INTO dossiers (tenant_id, check_in, check_out, guest_name, guest_email, referred_by_tenant_id)
       VALUES ($1, '2036-03-01', '2036-03-04', 'Voyageur Réseau', 'reseau@example.test', $2) RETURNING id`,
      [tenant, referredBy],
    );
    await pool.query(
      `INSERT INTO bookings (tenant_id, dossier_id, room_id, check_in, check_out, total_price, status, guest_name, guest_email, guest_count, source)
       VALUES ($1, $2, $3, '2036-03-01', '2036-03-04', '100.00', $4, 'Voyageur Réseau', 'reseau@example.test', 2, 'manual')`,
      [tenant, d.id, room, status],
    );
  };
  await dossier(T, ctx.apiRoomId, P.id, "confirmed"); // reçu et confirmé
  await dossier(P.id, P.roomId, T, "confirmed"); // envoyé et confirmé
  await dossier(T, ctx.apiRoomId, P.id, "pending"); // pas confirmé : ne compte pas
  await dossier(T, ctx.apiRoomId, null, "confirmed"); // pas attribué : ne compte pas
  await dossier(Q.id, Q.roomId, P.id, "confirmed"); // entre tiers : ne compte pas

  return {
    P: P.id,
    Q: Q.id,
    async cleanup() {
      const ids = [P.id, Q.id];
      await pool.query("DELETE FROM referrals WHERE from_tenant_id = ANY($1::uuid[]) OR to_tenant_id = ANY($1::uuid[])", [ids]);
      await pool.query("DELETE FROM referrals WHERE from_tenant_id = $1 OR to_tenant_id = $1", [T]);
      await pool.query("DELETE FROM bookings WHERE dossier_id IN (SELECT id FROM dossiers WHERE guest_email = 'reseau@example.test')");
      await pool.query("DELETE FROM dossiers WHERE guest_email = 'reseau@example.test'");
      await pool.query("DELETE FROM rooms WHERE tenant_id = ANY($1::uuid[])", [ids]);
      await pool.query("DELETE FROM properties WHERE tenant_id = ANY($1::uuid[])", [ids]);
      await pool.query("DELETE FROM tenants WHERE id = ANY($1::uuid[])", [ids]);
    },
  };
}

/** Lit « X voyageur(s) envoyé(s) · Y reçu(s) · Z réservation(s) » d'un bloc du compteur. */
export function parseCounts(text: string) {
  const n = (re: RegExp) => Number(re.exec(text)?.[1] ?? NaN);
  return { sent: n(/(\d+) voyageurs? envoyés?/), received: n(/(\d+) reçus?/), bookings: n(/(\d+) réservations?/) };
}
