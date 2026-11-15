---
version: 1
slug: "components-public-templates-affiche-css"
primary_target: "components/public/templates/affiche.css"
related_targets: ["components/public"]
---

# Surface: public guest site, template "affiche" → L'Affiche touristique

Scope: guest pages when config.template = "affiche". Mode: Persuade. Same audience, job and constraints as the Plaque émaillée brief.

## Direction contract

THESIS: A 1930s French railway tourism poster whose bottom band is the working booking engine: flat litho colour, giant condensed lettering, a layered bocage landscape with the house. Refuses the painted poster with a booking widget bolted on: the band is part of the poster.

OWN-WORLD: Sky = host secondary (lightness floored at 0.8), band = host primary (capped at 0.36), four flat greens, poster red #C4462F, paper #F7F0E1; no radii, no shadows. League Gothic for lettering, Libre Franklin for text. Full-bleed colour bands for sections (green stats band).

STORY: The guest sees the place name as a poster headline, the landscape with the house, then in the poster's band picks dates and sees the lettered rooms with prices; the rest of the page continues in poster bands.

FIRST VIEWPORT: Title at 12rem on the sky, red bar + place line, pitch; the SVG landscape across the full width; the deep band below holding « Vos dates » (left) and the lettered room list (right).

FORM: L'Affiche touristique, grounded candidate from the safer re-roll, chosen by the user. seed:e27b4d278916d490. Signature interaction: lettered room entries slide right on hover. Motion: shared staged settle.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
