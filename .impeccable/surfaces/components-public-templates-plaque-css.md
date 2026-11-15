---
version: 1
slug: "components-public-templates-plaque-css"
primary_target: "components/public/templates/plaque.css"
related_targets: ["components/public"]
---

# Surface: public guest site, template "classic" → La Plaque émaillée

Scope: every guest-facing page when tenant config.template = "classic" (home, /chambres, /chambres/[slug], /reserver/[roomId], /reserver/confirmation). Mode: Persuade.
Audience: French families and couples booking a gîte / chambre d'hôtes, often on a phone, often older; they compare with Booking/Airbnb. Job: trust the host, pick dates, see a total, pay.
Constraints: host colours (--color-primary = enamel, --color-secondary = wall tint) must lead; no invented facts (hide any block the host has not filled); text-led layout when there are no photos; JJ/MM/AAAA dates; booking-flow test ids unchanged.

## Direction contract

THESIS: Every part of the site is a French vitreous-enamel plate fixed on a limestone wall: nameplate, street-name nav plates, a road-direction sign that holds the date search, numbered room door plates. Refuses the full-bleed photo hero + floating date bar + equal room cards.

OWN-WORLD: Whitewashed limestone wall ground (secondary colour mixed into warm stone) with mortar courses; plates in the host's enamel colour with a 2px white inset border, 14px corners, screw heads; white plates with enamel border as the counter-plate; enamel red for the one action. Antonio condensed caps for everything lettered on a plate, Atkinson Hyperlegible for reading text. Tabular figures for prices.

STORY: The guest sees the house name on its plate, knows where it is (address/town line when filled), finds the date sign immediately, sees numbered rooms with prices, then books with a running total, reassured by plain facts.

FIRST VIEWPORT: Desktop: nameplate top-left (~55% width, display caps 6–7rem), room door plates stacked right, the direction-sign search spanning below the nameplate with its pointed end to the right, red plate CTA inside it. Street plates as nav top-right. Mobile: nameplate full width, sign below, rooms after.

FORM: La Plaque émaillée, my top-ranked grounded candidate (IMPECCABLE'S PICK, #1 of 7). seed:e27b4d278916d490. Signature interaction: plates press in (enamel depth shortens) on hover/active; the sign's arrow slides forward when dates are complete. Motion: one staged mount — plates "fixed" onto the wall in sequence (fade + 6px drop, 60ms steps), off under reduced motion.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
