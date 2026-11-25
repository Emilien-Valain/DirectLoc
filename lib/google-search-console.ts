import { createSign } from "node:crypto";
import { eq, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { tenants } from "@/db/schema";
import { DEMO_TENANT_SLUG } from "@/lib/demo";
import { mergeTenantConfig } from "@/lib/tenant-config";
import type { TenantConfig } from "@/lib/tenant-context";

/**
 * Inscription automatique des sites clients dans Google Search Console, via un compte de service :
 * jeton de vérification META (rendu par lib/seo.ts) → vérification → ajout du site → envoi du sitemap.
 * Les URL sont surchargeables pour les tests (faux Google local).
 */

const OAUTH_URL = process.env.GOOGLE_OAUTH_URL ?? "https://oauth2.googleapis.com/token";
const API = process.env.GOOGLE_API_BASE ?? "https://www.googleapis.com";
const SCOPES = "https://www.googleapis.com/auth/siteverification https://www.googleapis.com/auth/webmasters";

type ServiceAccount = { client_email: string; private_key: string };

/** Jeton OAuth du compte de service (JWT signé RS256), sans dépendance. */
async function accessToken(sa: ServiceAccount): Promise<string> {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iss: sa.client_email, scope: SCOPES, aud: OAUTH_URL, iat: now, exp: now + 3600 })}`;
  const jwt = `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(sa.private_key, "base64url")}`;
  const res = await fetch(OAUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  const json = (await res.json()) as { access_token?: string; error?: string };
  if (!json.access_token) throw new Error(`OAuth Google : ${json.error ?? res.status}`);
  return json.access_token;
}

async function call<T>(token: string, method: string, path: string, body?: object): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → HTTP ${res.status} ${text.slice(0, 200)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

/** Ajoute à la ressource vérifiée les propriétaires qui y manquent (aucun appel s'il n'en manque pas). */
async function addOwners(token: string, site: string, resource: { id: string; owners?: string[] }, owners: string[]) {
  const missing = owners.filter((o) => !resource.owners?.includes(o));
  if (!missing.length) return;
  await call(token, "PUT", `/siteVerification/v1/webResource/${encodeURIComponent(resource.id)}`, {
    site: { type: "SITE", identifier: site },
    owners: [...(resource.owners ?? []), ...missing],
  });
}

/**
 * Inscrit chaque hôtel avec domaine pas encore inscrit (hors démo) ; sur un site déjà inscrit, ajoute seulement
 * les nouveaux GOOGLE_SEARCH_CONSOLE_OWNERS. Idempotent : à lancer chaque jour,
 * un site dont le domaine ne répond pas encore est retenté au passage suivant.
 * Retourne un statut lisible par domaine.
 */
export async function registerSearchConsoleSites(): Promise<Record<string, string>> {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON non configuré");
  const token = await accessToken(JSON.parse(raw) as ServiceAccount);
  const owners = (process.env.GOOGLE_SEARCH_CONSOLE_OWNERS ?? "").split(",").map((s) => s.trim()).filter(Boolean);

  const list = await db.query.tenants.findMany({
    where: isNotNull(tenants.domain),
    columns: { id: true, slug: true, domain: true, config: true },
  });

  const results: Record<string, string> = {};
  for (const t of list) {
    const config = (t.config ?? {}) as TenantConfig;
    if (t.slug === DEMO_TENANT_SLUG) continue;
    const site = `https://${t.domain}/`;
    const save = (patch: Partial<TenantConfig>) =>
      db.update(tenants).set({ config: mergeTenantConfig(patch) }).where(eq(tenants.id, t.id));

    // Site déjà inscrit : seulement les propriétaires ajoutés à GOOGLE_SEARCH_CONSOLE_OWNERS depuis.
    if (config.searchConsoleAddedAt) {
      const known = config.searchConsoleOwners ?? [];
      if (owners.every((o) => known.includes(o))) continue;
      try {
        const id = encodeURIComponent(site);
        const resource = await call<{ id: string; owners?: string[] }>(
          token, "GET", `/siteVerification/v1/webResource/${encodeURIComponent(id)}`,
        );
        await addOwners(token, site, resource, owners);
        await save({ searchConsoleOwners: owners });
        results[t.domain!] = "propriétaires ajoutés";
      } catch (err) {
        console.error(`[search-console] ${t.domain} :`, err);
        results[t.domain!] = `échec, retenté au prochain passage : ${(err as Error).message}`;
      }
      continue;
    }

    try {
      // 1. Jeton META, enregistré pour que les pages publiques le rendent (lib/seo.ts).
      if (!config.googleSiteVerification) {
        const { token: tag } = await call<{ token: string }>(token, "POST", "/siteVerification/v1/token", {
          site: { type: "SITE", identifier: site },
          verificationMethod: "META",
        });
        const content = tag.match(/content="([^"]+)"/)?.[1];
        if (!content) throw new Error(`jeton META illisible : ${tag}`);
        await save({ googleSiteVerification: content });
      }

      // 2. Vérification : Google lit la balise sur la page d'accueil, en direct.
      const resource = await call<{ id: string; owners?: string[] }>(
        token, "POST", "/siteVerification/v1/webResource?verificationMethod=META",
        { site: { type: "SITE", identifier: site } },
      );

      // 3. Propriétaires humains, pour voir le site dans leur propre Search Console.
      await addOwners(token, site, resource, owners);

      // 4. Search Console : ajout du site puis du sitemap.
      const enc = encodeURIComponent(site);
      await call(token, "PUT", `/webmasters/v3/sites/${enc}`);
      await call(token, "PUT", `/webmasters/v3/sites/${enc}/sitemaps/${encodeURIComponent(`${site}sitemap.xml`)}`);

      await save({ searchConsoleAddedAt: new Date().toISOString(), searchConsoleOwners: owners });
      results[t.domain!] = "inscrit";
    } catch (err) {
      console.error(`[search-console] ${t.domain} :`, err);
      results[t.domain!] = `échec, retenté au prochain passage : ${(err as Error).message}`;
    }
  }
  return results;
}
