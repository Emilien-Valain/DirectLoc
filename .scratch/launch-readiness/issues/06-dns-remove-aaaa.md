# Supprimer les AAAA parking OVH

Status: resolved

Zone OVH `directloc.app` : supprimer `@ AAAA`, `* AAAA`, `www AAAA` (`2001:41d0:301::29`, parking OVH). Le VPS est IPv4 seul (`57.131.40.98`). Sinon : visiteurs IPv6 chez OVH, et Let's Encrypt (qui préfère IPv6) peut échouer.

Vérif : `curl -s "https://dns.google/resolve?name=directloc.app&type=AAAA"` → pas de `data`.

## Comments

2026-11-15 : 3 AAAA supprimés via ovhcloud CLI (ids 5413243058, 5413243062, 5413243080), zone rafraîchie.
