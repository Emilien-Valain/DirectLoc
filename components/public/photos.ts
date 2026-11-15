type Photo = { id: string; url: string; position: number };

/** Photos d'une chambre (colonne JSON), triées par position. */
export function sortedPhotos(photos: unknown): Photo[] {
  return (Array.isArray(photos) ? (photos as Photo[]) : []).slice().sort((a, b) => a.position - b.position);
}
