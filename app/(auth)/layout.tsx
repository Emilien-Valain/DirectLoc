import type { Metadata } from "next";
import { DIRECTLOC_ICONS } from "@/lib/brand";

// Connexion, mot de passe oublié, réinitialisation : pages de la marque DirectLoc.
export const metadata: Metadata = { icons: DIRECTLOC_ICONS };

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return children;
}
