# Brancher directloc.app dans Coolify + déployer

Status: ready-for-human
Blocked by: 06, 07, 01-04

`https://directloc.app` sert le cert par défaut de Traefik + 404 : domaine absent de l'app Coolify ou app arrêtée. Ajouter le domaine, vérifier l'env (dont `STRIPE_CONNECT_WEBHOOK_SECRET`), health check `/api/health`, volume `/app/uploads`. Cf. Obsidian `Guide Déploiement VPS.md`.

## Comments

**2026-11-15.** En ligne : cert Let's Encrypt OK sur `directloc.app` + `www` (302 → apex), `/api/health` 200. Échec de build passager (téléchargement Google Fonts), redeploy OK. Restent :
- `MARKETING_HOST=directloc.app` (sinon `/` = 404) — nécessite le correctif proxy (webhook + health exemptés de la vitrine).
- Scheduled Tasks : `curl` absent de l'image → `wget -qO- --header=... http://127.0.0.1:3000/...` (doc corrigée).
- Health check Coolify non configuré.
