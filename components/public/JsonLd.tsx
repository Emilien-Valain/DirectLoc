/** Données structurées schema.org. `<` échappé : un texte saisi par l'hôte ne peut pas fermer la balise script. */
export default function JsonLd({ data }: { data: object }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, "\\u003c") }}
    />
  );
}
