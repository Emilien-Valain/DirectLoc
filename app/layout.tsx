import type { Metadata, Viewport } from "next";
import {
  Anton,
  Antonio,
  Atkinson_Hyperlegible,
  Epilogue,
  Hanken_Grotesk,
  Instrument_Sans,
  Instrument_Serif,
  League_Gothic,
  Libre_Franklin,
  Literata,
  Figtree,
  JetBrains_Mono,
  Plus_Jakarta_Sans,
  Public_Sans,
  Source_Serif_4,
} from "next/font/google";
import "./globals.css";

// Police "body" globale.
const body = Figtree({
  variable: "--font-sans",
  subsets: ["latin"],
  preload: false, // admin uniquement : pas de préchargement sur les sites clients
});

const mono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400"],
  preload: false,
});

// Plus Jakarta Sans — admin et écrans d'authentification.
const jakarta = Plus_Jakarta_Sans({
  variable: "--font-jakarta",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  preload: false,
});

// Polices des templates publics. preload: false : chaque page ne télécharge
// que les polices de son template (la feuille CSS du template les référence).
// Plaque émaillée
const antonio = Antonio({ variable: "--font-antonio", subsets: ["latin"], weight: ["500", "700"], preload: false });
const atkinson = Atkinson_Hyperlegible({ variable: "--font-atkinson", subsets: ["latin"], weight: ["400", "700"], preload: false });
// Linge de maison
const epilogue = Epilogue({ variable: "--font-epilogue", subsets: ["latin"], weight: ["500", "800"], preload: false });
const literata = Literata({ variable: "--font-literata", subsets: ["latin"], preload: false });
// Affiche touristique
const leagueGothic = League_Gothic({ variable: "--font-league-gothic", subsets: ["latin"], preload: false });
const franklin = Libre_Franklin({ variable: "--font-franklin", subsets: ["latin"], preload: false });
// Classique (standard de la catégorie)
const hanken = Hanken_Grotesk({ variable: "--font-hanken", subsets: ["latin"], preload: false });
// Le Carnet (magazine de voyage)
const instrumentSerif = Instrument_Serif({ variable: "--font-instrument-serif", subsets: ["latin"], weight: "400", style: ["normal", "italic"], preload: false });
const instrumentSans = Instrument_Sans({ variable: "--font-instrument-sans", subsets: ["latin"], weight: ["400", "500", "600", "700"], preload: false });
const sourceSerif = Source_Serif_4({ variable: "--font-source-serif", subsets: ["latin"], weight: ["400"], style: ["normal", "italic"], preload: false });
// Le Défilant et La Carte postale (grandes lettres)
const anton = Anton({ variable: "--font-anton", subsets: ["latin"], weight: "400", preload: false });
// Le Guide du parc (brochure Unigrid) — Source Serif 4 partagée avec le Carnet
const publicSans = Public_Sans({ variable: "--font-public-sans", subsets: ["latin"], weight: ["400", "600", "800"], preload: false });

export const metadata: Metadata = {
  title: "DirectLoc",
  description: "Plateforme de reservation directe pour hotels",
  // Icône par défaut neutre (public/favicon.ico, une maison grise) : les sites d'hôtel sont
  // en marque blanche, le voyageur ne doit jamais voir DirectLoc. Un hôtel la remplace par
  // la sienne (lib/seo.ts, tenantIcons) ; vitrine, admin et connexion prennent DIRECTLOC_ICONS.
  icons: { icon: [{ url: "/favicon.ico", sizes: "any" }] },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="fr"
      className={`${body.variable} ${mono.variable} ${jakarta.variable} ${antonio.variable} ${atkinson.variable} ${epilogue.variable} ${literata.variable} ${leagueGothic.variable} ${franklin.variable} ${hanken.variable} ${instrumentSerif.variable} ${instrumentSans.variable} ${sourceSerif.variable} ${publicSans.variable} ${anton.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
