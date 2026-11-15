# Launch readiness — directloc.app

Status: in-progress

Source : audit `/ponytail-audit` du 2026-11-05 (prod-readiness). Objectif : l'app tourne en prod sur `directloc.app` et sur le domaine d'un premier hôtel, paiement Stripe réel validé, pages légales en ligne.

Constat live au 2026-11-05 : `https://directloc.app` répond avec `TRAEFIK DEFAULT CERT` + 404 ; enregistrements `AAAA` → `2001:41d0:301::29` (parking OVH) sur `@`, `*`, `www`.

| # | Issue | Status |
|---|-------|--------|
| 01 | Better Auth refuse les POST avec cookie sur les domaines tenants en prod | resolved |
| 02 | Lien reset password construit sur directloc.app | resolved |
| 03 | `create-admin` absent de l'image Docker | resolved |
| 04 | `www.<domaine>` → 404 | resolved |
| 05 | Tenant sans Stripe Connect encaisse sur le compte plateforme | needs-info |
| 06 | Supprimer les AAAA parking OVH | resolved |
| 07 | Commiter le travail en cours (140 fichiers) | resolved |
| 08 | Brancher directloc.app dans Coolify + déployer | ready-for-human |
| 09 | Aller-retour Stripe réel (2 endpoints webhook) | ready-for-human |
| 10 | Pages légales (mentions, CGV/réservation, confidentialité) | needs-info |
| 11 | Site vitrine sur l'apex directloc.app | needs-triage |

Ordre : 06 → 07 → 01-04 → 08 → 09 → 10/11. Checklist post-déploiement non bloquante : [[À faire avant release]] dans l'Obsidian Vault.
