import type { Metadata } from "next";

/** Icônes DirectLoc : seulement sur les pages de la marque (vitrine, admin, connexion), jamais sur un site d'hôtel. */
export const DIRECTLOC_ICONS: Metadata["icons"] = {
  icon: [
    { url: "/brand/favicon.ico", sizes: "any" },
    { url: "/brand/directloc-mark.svg", type: "image/svg+xml" },
  ],
  apple: [{ url: "/brand/apple-touch-icon.png", sizes: "180x180" }],
};
