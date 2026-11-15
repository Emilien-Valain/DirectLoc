# `www.<domaine>` → 404

Status: resolved

## Problème

`proxy.ts` (`resolveTenant`, branche prod) cherche le tenant par égalité stricte `tenants.domain = host`. La doc recommande d'ajouter aussi `www.<domaine>` dans Coolify : ce host ne matche aucun tenant → 404.

## Attendu

En prod, `www.hotelducoin.fr` sert le même tenant que `hotelducoin.fr` (normaliser `host` en retirant un préfixe `www.` avant le lookup ; le cache reste indexé par host). Pas de changement en dev (`*.localhost`).

## Done quand

- Test : un host `www.<domain-du-tenant-de-test>` résout le tenant (test unitaire sur une fonction pure de normalisation dans `e2e/unit/`, ou E2E si le routage prod est atteignable en test).
- `npx tsc --noEmit` et `npx eslint` sans nouvelle erreur.

## Comments

**Résolu (agent)**

- `lib/tenant-host.ts:2` — nouvelle fonction pure `apexHost(host)` : minuscules + retrait d'un préfixe `www.` en tête.
- `proxy.ts:66` — branche prod de `resolveTenant` : `inArray(tenants.domain, [host, apexHost(host)])` (le host brut reste candidat si un domaine a été saisi avec `www.`). Cache toujours indexé par host. Branche dev `*.localhost` inchangée.
- `e2e/unit/tenant-host.spec.ts` — test unitaire Playwright (import direct, pas de sonde).
- Autres usages du host vérifiés : `app/robots.ts`, `app/sitemap.ts`, `app/admin/parametres`, `stripe/connect`, `bookings-public.ts` ne résolvent pas le tenant par host (ils construisent des URLs ; le tenant vient de `x-tenant-id`) → rien à aligner. `lib/tenant-context.ts` ne lit pas le host.
- Vérif : `npx tsc --noEmit` OK, `npx eslint proxy.ts lib/tenant-host.ts e2e/unit/tenant-host.spec.ts` OK, `npx tsx` sur `apexHost` OK. Playwright non lancé (port/DB partagés).

Spec Obsidian (« Tests de non-régression.md ») :

> **Résolution tenant `www.`** (`e2e/unit/tenant-host.spec.ts`) — En prod, le proxy cherche le tenant par le host brut ou son apex : `www.hotelducoin.fr` sert le même tenant que `hotelducoin.fr` au lieu d'un 404. `apexHost` passe en minuscules et ne retire qu'un préfixe `www.` en tête (`www2.`, `wwwhotel.fr`, `shop.www.` inchangés). Le dev `*.localhost` n'est pas concerné.
