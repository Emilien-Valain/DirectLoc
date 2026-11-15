import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { eq, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/db/schema";
import { sendPasswordResetEmail } from "@/lib/email";
import type { TenantConfig } from "@/lib/tenant-context";
import { prodTrustedOrigins } from "@/lib/trusted-origins";

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
    schema,
    usePlural: true,
  }),

  emailAndPassword: {
    enabled: true,
    // Les admins sont créés par scripts/create-admin.ts : une inscription publique
    // permettrait de pré-créer le compte d'un futur hôte avec son propre mot de passe.
    disableSignUp: true,
    async sendResetPassword({ user, url }) {
      // Résoudre le tenant de l'admin pour brander l'email
      let hotelName: string | undefined;
      let config: TenantConfig | undefined;
      let domain: string | null = null;

      const membership = await db.query.userTenants.findFirst({
        where: eq(schema.userTenants.userId, user.id),
      });

      if (membership) {
        const [tenant] = await db
          .select({
            name: schema.tenants.name,
            config: schema.tenants.config,
            domain: schema.tenants.domain,
          })
          .from(schema.tenants)
          .where(eq(schema.tenants.id, membership.tenantId))
          .limit(1);

        if (tenant) {
          hotelName = tenant.name;
          config = (tenant.config ?? {}) as TenantConfig;
          domain = tenant.domain;
        }
      }

      // Better Auth bâtit le lien sur BETTER_AUTH_URL, qui n'a pas de tenant : on le
      // ramène sur le domaine de l'hôtel de l'admin, à défaut sur l'origine d'où il a
      // demandé le reset (callbackURL, déjà validée comme origine de confiance).
      const link = new URL(url);
      const callback = link.searchParams.get("callbackURL");
      const origin = domain
        ? `https://${domain}`
        : callback && URL.canParse(callback)
          ? new URL(callback).origin
          : link.origin;
      const resetUrl = `${origin}${link.pathname}?callbackURL=${encodeURIComponent(`${origin}/reset-password`)}`;

      await sendPasswordResetEmail({
        userName: user.name,
        userEmail: user.email,
        resetUrl,
        hotelName,
        config,
      });
    },
  },

  // En dev, tous les *.localhost:<port> sont des origines de confiance
  // Le port est dérivé de BETTER_AUTH_URL pour couvrir aussi le port 3001 des tests
  // Chaque sous-domaine gère sa propre session (miroir du comportement prod)
  ...(process.env.NODE_ENV === "development" ? (() => {
    const devUrl = new URL(process.env.BETTER_AUTH_URL ?? "http://localhost:3000");
    const port = devUrl.port ? `:${devUrl.port}` : "";
    return {
      trustedOrigins: [
        devUrl.origin,
        `*.localhost${port}`,
      ],
    };
  })() : {
    // En prod, chaque domaine tenant doit être de confiance, sinon les POST avec
    // cookie (signOut, reconnexion) sont refusés en INVALID_ORIGIN.
    // shortcut: une requête DB par appel auth, ajouter un cache court si le nombre de tenants grossit.
    trustedOrigins: async (request) => {
      // Appelée aussi à l'init de Better Auth (sans requête, ex. pendant le build) :
      // pas de DB à ce moment-là, BETTER_AUTH_URL suffit.
      if (!request) return [];
      const rows = await db
        .select({ domain: schema.tenants.domain })
        .from(schema.tenants)
        .where(isNotNull(schema.tenants.domain));
      return prodTrustedOrigins(
        rows.map((r) => r.domain),
        process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
      );
    },
  }),
});

export type Session = typeof auth.$Infer.Session;
export type User = typeof auth.$Infer.Session.user;
