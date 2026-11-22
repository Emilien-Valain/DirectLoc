import type { Metadata } from "next";
import { EDITOR } from "../legal";
import { LegalShell } from "../LegalShell";

export const metadata: Metadata = { title: "Politique de confidentialité — DirectLoc", alternates: { canonical: "/confidentialite" } };

export default function Confidentialite() {
  return (
    <LegalShell title="Politique de confidentialité" updated={EDITOR.updated}>
      <p>Cette page concerne le site de présentation directloc.app. Votre numéro sert uniquement à vous rappeler.</p>

      <h2>Responsable du traitement</h2>
      <p>
        {EDITOR.name}, {EDITOR.status} (SIREN {EDITOR.siren}), {EDITOR.address}. Contact :{" "}
        <a href={`mailto:${EDITOR.email}`}>{EDITOR.email}</a>.
      </p>

      <h2>Demande de rappel</h2>
      <p>Si vous remplissez le formulaire « Être rappelé », nous recevons par email :</p>
      <ul>
        <li>votre nom et votre numéro de téléphone (obligatoires) ;</li>
        <li>le nom ou la commune de votre hébergement (facultatif) ;</li>
        <li>le code partenaire de l&apos;adresse par laquelle vous êtes arrivé, s&apos;il y en a un.</li>
      </ul>
      <p>
        Finalité : vous rappeler pour présenter DirectLoc. Base légale : mesures précontractuelles prises à votre
        demande et intérêt légitime à répondre aux demandes reçues. Vos données ne sont ni revendues ni utilisées
        pour du démarchage sans rapport avec votre demande.
      </p>
      <p>
        Conservation : jusqu&apos;à 3 ans après notre dernier contact, puis suppression. Si vous ne donnez pas suite,
        votre demande est supprimée au plus tard à ce terme.
      </p>

      <h2>Mesure d&apos;audience</h2>
      <p>
        Nous utilisons PostHog (hébergé dans l&apos;Union européenne) pour comprendre comment le site est utilisé.
        Un bandeau vous demande votre accord :
      </p>
      <ul>
        <li><strong>Vous acceptez</strong> : cookies de mesure et enregistrement anonymisé de certaines visites (les champs de saisie sont masqués).</li>
        <li><strong>Vous refusez, ou n&apos;avez pas encore choisi</strong> : les visites sont comptées de façon anonyme, sans cookie.</li>
      </ul>
      <p>
        Le dépôt de cookies repose sur votre consentement, que vous pouvez refuser sans conséquence. Le comptage
        anonyme repose sur notre intérêt légitime à connaître la fréquentation. Lorsque vous envoyez une demande de
        rappel, un événement anonyme « demande envoyée » est enregistré, sans votre nom ni votre numéro.
      </p>

      <h2>Destinataires</h2>
      <ul>
        <li>{EDITOR.name}, seul à recevoir vos demandes de rappel ;</li>
        <li>{EDITOR.host.name} ({EDITOR.host.address}), hébergeur du site ;</li>
        <li>PostHog, mesure d&apos;audience (serveurs dans l&apos;UE) ;</li>
        <li>notre prestataire d&apos;envoi d&apos;emails, par lequel transite la demande de rappel.</li>
      </ul>

      <h2>Vos droits</h2>
      <p>
        Vous pouvez demander l&apos;accès, la rectification ou l&apos;effacement de vos données, vous opposer à leur
        traitement ou en demander la limitation, en écrivant à <a href={`mailto:${EDITOR.email}`}>{EDITOR.email}</a>.
        Vous pouvez aussi retirer votre consentement aux cookies à tout moment en supprimant les cookies de ce site.
        En cas de désaccord, vous pouvez saisir la CNIL (<a href="https://www.cnil.fr/fr/plaintes">cnil.fr/plaintes</a>).
      </p>
    </LegalShell>
  );
}
