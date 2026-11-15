FROM node:20-alpine AS base

# ── Build ────────────────────────────────────────────────────────────────────
FROM base AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build
# create-admin autonome (le runner n'a ni tsx ni node_modules complet)
RUN npx esbuild scripts/create-admin.ts --bundle --platform=node --format=esm --target=node20 \
      --outfile=scripts/create-admin.mjs \
      --banner:js="import{createRequire}from'module';const require=createRequire(import.meta.url);"

# ── Production ───────────────────────────────────────────────────────────────
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production

# sharp a besoin de vips sur Alpine
RUN apk add --no-cache vips

# Standalone output (serveur + dépendances minimales)
COPY --from=builder /app/.next/standalone ./
# Assets statiques (non inclus dans standalone par défaut)
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# Migrations : script + fichiers SQL
COPY --from=builder /app/scripts/migrate.mjs ./scripts/migrate.mjs
COPY --from=builder /app/db/migrations ./db/migrations
# Création tenant + admin : node scripts/create-admin.mjs --name ... (lit DATABASE_URL)
COPY --from=builder /app/scripts/create-admin.mjs ./scripts/create-admin.mjs

# Dossier uploads (à monter comme volume persistent)
RUN mkdir -p /app/uploads

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Lancer les migrations puis démarrer le serveur
CMD ["sh", "-c", "node scripts/migrate.mjs && node server.js"]
