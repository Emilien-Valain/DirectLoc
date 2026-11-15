import type { Metadata } from "next";
import { Archivo, Big_Shoulders, Source_Serif_4 } from "next/font/google";
import "./vitrine.css";

// Monde « Almanach » du site vitrine : jamais chargé par l'admin ni par les sites clients.
const display = Big_Shoulders({ variable: "--alm-display", subsets: ["latin"], weight: ["700", "900"], adjustFontFallback: false });
const serif = Source_Serif_4({ variable: "--alm-serif", subsets: ["latin"], style: ["normal", "italic"] });
const ui = Archivo({ variable: "--alm-ui", subsets: ["latin"], weight: ["500", "600", "700"] });

export const metadata: Metadata = {
  title: "DirectLoc — votre site de réservation, zéro commission",
  description:
    "Un site de réservation à votre nom pour votre gîte ou chambre d'hôtes en Vendée Bocage : zéro commission, calendriers Airbnb et Booking synchronisés, installé par quelqu'un du coin.",
};

export default function VitrineLayout({ children }: { children: React.ReactNode }) {
  return <div className={`alm ${display.variable} ${serif.variable} ${ui.variable}`}>{children}</div>;
}
