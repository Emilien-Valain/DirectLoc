import type { Metadata } from "next";
import { EDITOR } from "../legal";
import { LegalShell } from "../LegalShell";

export const metadata: Metadata = { title: "Mentions légales — DirectLoc", alternates: { canonical: "/mentions-legales" } };

export default function MentionsLegales() {
  return (
    <LegalShell title="Mentions légales" updated={EDITOR.updated}>
      <h2>Éditeur du site</h2>
      <p>
        Le site directloc.app, service « DirectLoc », est édité par <strong>{EDITOR.name}</strong>,{" "}
        {EDITOR.status} (SIREN {EDITOR.siren}), nom commercial « {EDITOR.name} ».
      </p>
      <ul>
        <li>Adresse : {EDITOR.address}</li>
        <li>Téléphone : <a href={EDITOR.phoneHref}>{EDITOR.phone}</a></li>
        <li>Email : <a href={`mailto:${EDITOR.email}`}>{EDITOR.email}</a></li>
      </ul>
      <p>Directeur de la publication : {EDITOR.name}.</p>

      <h2>Hébergement</h2>
      <p>{EDITOR.host.name}, {EDITOR.host.address}.</p>

      <h2>Propriété intellectuelle</h2>
      <p>
        Les textes, visuels et le nom DirectLoc sont la propriété de l&apos;éditeur. Toute reproduction sans
        autorisation écrite est interdite.
      </p>

      <h2>Données personnelles</h2>
      <p>
        Le traitement de vos données est décrit dans la <a href="/confidentialite">politique de confidentialité</a>.
      </p>
    </LegalShell>
  );
}
