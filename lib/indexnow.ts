import { after } from "next/server";
import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { rooms, tenants } from "@/db/schema";

/**
 * IndexNow : signale à Bing (et donc à la recherche ChatGPT), Yandex, Seznam…
 * les pages publiques ajoutées, modifiées ou supprimées. Google ne l'utilise pas.
 * Une seule clé pour tous les domaines, servie par chaque hôte sur /indexnow.txt.
 */

/** Envoie jusqu'à 10 000 URL d'un même hôte. Ne lève jamais : un échec ne doit pas bloquer l'admin. */
export async function submitIndexNow(host: string, paths: string[]): Promise<boolean> {
  const key = process.env.INDEXNOW_KEY;
  if (!key || paths.length === 0) return false;
  try {
    const res = await fetch(process.env.INDEXNOW_ENDPOINT ?? "https://api.indexnow.org/indexnow", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        host,
        key,
        keyLocation: `https://${host}/indexnow.txt`,
        urlList: [...new Set(paths)].map((p) => `https://${host}${p}`),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    // 200 = reçu, 202 = reçu, clé en cours de vérification.
    if (!res.ok) console.error(`[indexnow] ${host} : HTTP ${res.status}`);
    return res.ok;
  } catch (err) {
    console.error(`[indexnow] ${host} :`, err);
    return false;
  }
}

/** À appeler depuis une server action : l'envoi part après la réponse. Hôtel sans domaine = rien. */
export function notifyIndexNow(tenantId: string, paths: string[]) {
  if (!process.env.INDEXNOW_KEY) return;
  after(async () => {
    const tenant = await db.query.tenants.findFirst({
      where: eq(tenants.id, tenantId),
      columns: { domain: true },
    });
    if (tenant?.domain) await submitIndexNow(tenant.domain, paths);
  });
}

/** Toutes les pages publiques de chaque hôtel ayant un domaine (envoi initial). */
export async function allTenantPages(): Promise<{ host: string; paths: string[] }[]> {
  const list = await db.query.tenants.findMany({
    where: isNotNull(tenants.domain),
    columns: { id: true, domain: true },
  });
  return Promise.all(
    list.map(async (t) => {
      const active = await db
        .select({ slug: rooms.slug })
        .from(rooms)
        .where(and(eq(rooms.tenantId, t.id), eq(rooms.active, true)));
      return { host: t.domain!, paths: ["/", "/chambres", ...active.map((r) => `/chambres/${r.slug}`)] };
    }),
  );
}
