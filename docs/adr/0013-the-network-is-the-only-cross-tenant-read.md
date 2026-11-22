# The Voisin network is the only cross-tenant read, and it exposes no booking data

ADR-0002 makes each hotel an isolated [[tenant]]. The [[voisin|Voisin]] network breaks this on purpose: a full tenant's public site must know which nearby tenants can admit a stay. We allow exactly one cross-tenant read path, confined to one module, which returns for each Voisin only public business facts (name, commune, distance, main photo, phone) and a yes/no — or a head-count — answer to "can you admit this stay?", computed by a dry run of that Voisin's own admission gate (ADR-0008) without writing anything.

No Booking, Dossier, guest or price ever crosses tenants. A [[renvoi|Renvoi]] is a link to the Voisin's own domain; the resulting reservation is created and paid on the Voisin's site. Attribution is a marker carried in the URL for the visit only (no cookie). Notifications to the sending host name the dates and the Voisin, never the guest.

Notifications (`lib/network-notify.ts`, part of the network module) read the other tenant's name and phone only, and, for a shared stay, whether both linked Dossiers are confirmed; the two Dossiers are linked through the shared Renvoi (the host's Dossier id is read by `/voisin` on the host's own domain and never forwarded to the Voisin).

Membership is on by default, reciprocal, and requires the tenant's GPS position; the operator can switch a tenant out.

## Rejected alternatives

- *Booking on behalf of the Voisin from the full tenant's site* — moves guest data and money across tenants, needs a cross-tenant transaction, and the guest would pay a business whose site they never saw.
- *Cookie-based attribution* — catches return visits but requires a consent banner on every tenant site.
