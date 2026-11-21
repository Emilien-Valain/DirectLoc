/**
 * Dossiers pour les réservations insérées à la main par les tests (ADR-0012 :
 * toute réservation appartient à un Dossier). Le contenu du Dossier (voyageur,
 * dates) n'est pas lu par l'app tant que les réservations en portent la copie.
 */

type Queryable = { query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> };

export async function insertDossier(
  q: Queryable,
  tenantId: string,
  stay: { checkIn?: string | Date; checkOut?: string | Date; guestName?: string; guestEmail?: string } = {},
): Promise<string> {
  const { rows } = await q.query(
    `INSERT INTO dossiers (tenant_id, check_in, check_out, guest_name, guest_email)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [
      tenantId,
      stay.checkIn ?? "2030-01-01",
      stay.checkOut ?? "2030-01-02",
      stay.guestName ?? "Dossier Test",
      stay.guestEmail ?? "dossier@example.com",
    ],
  );
  return rows[0].id as string;
}

/** Retire les Dossiers dont les réservations et paiements ont été supprimés par un test. */
export async function deleteOrphanDossiers(q: Queryable): Promise<void> {
  await q.query(
    `DELETE FROM dossiers d
     WHERE NOT EXISTS (SELECT 1 FROM bookings b WHERE b.dossier_id = d.id)
       AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.dossier_id = d.id)`,
  );
}
