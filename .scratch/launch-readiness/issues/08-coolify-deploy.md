# Brancher directloc.app dans Coolify + déployer

Status: ready-for-human
Blocked by: 06, 07, 01-04

`https://directloc.app` sert le cert par défaut de Traefik + 404 : domaine absent de l'app Coolify ou app arrêtée. Ajouter le domaine, vérifier l'env (dont `STRIPE_CONNECT_WEBHOOK_SECRET`), health check `/api/health`, volume `/app/uploads`. Cf. Obsidian `Guide Déploiement VPS.md`.

## Comments
