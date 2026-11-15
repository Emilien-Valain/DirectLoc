# Export CSV de la taxe de séjour

Status: done
Blocked by: 02

## À faire
- Dans la section « Taxe de séjour » : choix de période + bouton export CSV (route admin scoped tenant).
- 1 ligne par séjour `confirmed | completed` dont le départ est dans la période : arrivée, départ, nuits, adultes, mineurs exonérés, exonération admin oui/non, montant collecté. Total en bas.
- Encodage compatible Excel FR (BOM UTF-8, séparateur `;`).

## Tests
- Résa annulée exclue ; départ hors période exclu ; résa exonérée présente avec 0 € ; période invalide (`?from=abc`) → erreur propre, pas de 500 ; sans session → `/login` ; données d'un autre tenant absentes.

## Comments
