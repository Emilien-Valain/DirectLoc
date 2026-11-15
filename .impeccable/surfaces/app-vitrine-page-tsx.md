---
version: 1
slug: "app-vitrine-page-tsx"
primary_target: "app/vitrine/page.tsx"
related_targets: ["app/vitrine"]
---

# Site vitrine directloc.app

Scope: the platform's own marketing site, served on the marketing host (MARKETING_HOST, prod directloc.app) by rewrite to `app/vitrine/*`. Mode: Persuade.

- Audience: small hosts of Vendée Bocage / Puy du Fou (gîtes, meublés, chambres d'hôtes, petits hôtels), often alone, rural, sometimes senior. Three profiles: OTA-dependent, Open System users, subscription-wary.
- Job: understand « votre site, votre domaine, zéro commission, installé par quelqu'un du coin » and believe it pays for itself.
- Action: « Être rappelé » (name + phone) in its working form in the first viewport and at the close. Secondary: « Essayer l'admin » (demo account, built in a later step).
- Proof: commission math with sources (17 %, Toploc 2026; 666 € séjour moyen); demo data labelled fictitious. No testimonials, logos or usage counts.
- Network: cross-referral to neighbouring DirectLoc hosts when full is presented as a real feature (user decision 2026-11-05); shared SEO articles live on this site and link out to client domains. Never claim a member count.
- Constraints: French; body ≥ 17px; WCAG AA; pricing is draft and must be flagged to the user before going live.

## Direction contract

THESIS: The page is the almanac every bocage kitchen hangs on the wall; the host's year is filled in by direct bookings at 0 € commission. Refuses the SaaS split hero with product screenshot and three feature cards.

OWN-WORLD: Glossy cover blue #23408E with gold foil #C9A227 lettering; white month leaves ruled in blue-grey, Sundays and holidays in almanac red #D7262E; stays drawn as inked bars on the grid (green direct, dashed grey iCal); Big Shoulders Display condensed capitals for months and headings, Source Serif 4 for saints, notes and reading text, Archivo for controls and figures (tabular). Coupons are dashed gold tear-offs; tables are almanac « barèmes ».

STORY: The visitor sees their own summer as a calendar, reads that every direct stay keeps ~113 €, computes their own yearly loss in the barème, sees calendars merged by iCal, the four site covers, the neighbour-referral network, the prices in full, then asks to be called back.

FIRST VIEWPORT: Blue cover band across the top with the wordmark left, nav right and the two-line headline in gold/white capitals. Below, left two thirds: the July leaf of the demo gîte with five stays drawn on the grid and a green stamp « Gardé : 113 € par séjour ». Right third: the tear-off coupon with name, phone and the red « Être rappelé » button, then « Essayer l'admin » under it.

FORM: Almanach (pick, position 1 of 7 on the grounded list); seed:8794cf045bdd0751. Signature interaction: the commission barème recalculates live from the visitor's own OTA revenue, and the stamp lands once on arrival (one staged settle of leaf, stays, stamp).

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
