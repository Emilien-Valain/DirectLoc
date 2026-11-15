# Mise en prod de la démo

Status: ready-for-human
Blocked by: 01-04

1. ~~Détacher `contact@directloc.app` du tenant `demo`~~ : automatique, `resetDemoTenant()` retire tout autre admin de l'hôtel démo.
2. Coolify env : `DEMO_TENANT_SLUG=demo`, `DEMO_TENANT_DOMAIN=demo.directloc.app`, (au passage en live) `STRIPE_TEST_SECRET_KEY`, `STRIPE_TEST_WEBHOOK_SECRET`.
3. Coolify domaine : `demo.directloc.app` (https, port 3000).
4. Scheduled Task : `0 3 * * *` → `wget -qO- --header="Authorization: Bearer $CRON_SECRET" http://127.0.0.1:3000/api/cron/demo-reset`.
5. Lancer le reset une fois à la main, puis tester : `https://directloc.app/essayer` → admin démo connecté ; `https://directloc.app/site-demo` → site démo avec bandeau.

## Comments
