# Uploads path-traversal check accepts sibling folders

Status: resolved — startsWith(root + path.sep)
Group: Should fix

## Problem

`app/api/uploads/[...path]/route.ts:25` checks `resolved.startsWith(path.resolve(UPLOADS_ROOT))`. With `UPLOADS_DIR=/data/uploads`, the path `/data/uploads-backup/secret` passes the check. A request whose segments resolve through `..` to a sibling folder whose name starts with `uploads` would serve any file in that folder.

## Fix

```ts
const root = path.resolve(UPLOADS_ROOT);
if (!resolved.startsWith(root + path.sep)) { ...403 }
```

## Acceptance

- Test in `e2e/public/security.spec.ts`: `/api/uploads/..%2Fuploads-x%2Ffile` (and plain `../`) gives 403 or 404, never 200.
- Existing photo display tests still pass.

## Comments

- `app/api/uploads/[...path]/route.ts` : le préfixe inclut le séparateur.
- Test : `e2e/public/security.spec.ts` « /api/uploads reste dans le dossier uploads » : crée un dossier voisin `uploads-x-<run>/secret.webp`, puis `..%2F…`, `%2E%2E/…`, `..%2Fpackage.json` → 403/404. Dossier supprimé en afterAll.
- Vérifié par mutation : sans `+ path.sep`, le test échoue (200).
