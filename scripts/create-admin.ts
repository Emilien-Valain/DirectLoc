/**
 * Crée un tenant et un utilisateur admin en ligne de commande.
 *
 * Usage :
 *   npm run create-admin -- \
 *     --name "Hôtel du Coin" \
 *     --slug "hotel-du-coin" \
 *     --domain "hotelducoin.fr" \
 *     --email "contact@hotelducoin.fr" \
 *     --password "motdepasse" \
 *     --template boutique        # optionnel, défaut : classic
 *     --link-existing            # optionnel : donne accès à un utilisateur déjà existant
 */

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { tenants, users, properties, userTenants } from "@/db/schema";
import { TEMPLATE_NAMES, type TemplateName } from "@/lib/tenant-context";
import { createCredentialUser } from "@/lib/credential-user";

const VALID_TEMPLATES: readonly TemplateName[] = TEMPLATE_NAMES;

async function main() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const idx = args.indexOf(flag);
    return idx !== -1 ? args[idx + 1] : undefined;
  };

  const name = get("--name");
  const slug = get("--slug");
  const domain = get("--domain");
  const email = get("--email");
  const password = get("--password");
  const templateArg = get("--template");

  if (!name || !slug || !email || !password) {
    console.error(
      "Usage: --name <name> --slug <slug> --email <email> --password <password> [--domain <domain>] [--template classic|boutique|affiche|standard|carnet|guide|defilant|postale]",
    );
    process.exit(1);
  }

  if (templateArg && !VALID_TEMPLATES.includes(templateArg as TemplateName)) {
    console.error(`Template invalide : "${templateArg}". Valeurs possibles : ${VALID_TEMPLATES.join(", ")}`);
    process.exit(1);
  }

  const template = (templateArg as TemplateName | undefined) ?? "classic";

  // Un compte existant n'est relié qu'explicitement : son mot de passe n'est pas
  // celui passé ici, on donnerait l'hôtel à quiconque a créé ce compte avant nous.
  const existingUser = await db.query.users.findFirst({
    where: eq(users.email, email),
  });
  if (existingUser && !args.includes("--link-existing")) {
    console.error(
      `L'utilisateur ${email} existe déjà et son mot de passe n'est pas --password. ` +
        "Vérifiez que c'est bien lui, puis relancez avec --link-existing.",
    );
    process.exit(1);
  }

  // 1. Créer le tenant (idempotent sur le slug)
  const existing = await db.query.tenants.findFirst({
    where: eq(tenants.slug, slug),
  });

  const tenant =
    existing ??
    (await db.insert(tenants).values({ name, slug, domain, config: { template } }).returning())[0];

  console.log(
    existing
      ? `ℹ Tenant existant réutilisé : ${tenant.name} (${tenant.id})`
      : `✓ Tenant créé : ${tenant.name} (${tenant.id})`,
  );

  // 2. Créer la property par défaut si absente (1 tenant = 1 property)
  const existingProp = await db.query.properties.findFirst({
    where: eq(properties.tenantId, tenant.id),
  });
  if (!existingProp) {
    await db.insert(properties).values({ tenantId: tenant.id, name });
    console.log(`✓ Propriété créée : ${name}`);
  }

  let userId: string;

  if (existingUser) {
    userId = existingUser.id;
    console.log(`ℹ Utilisateur existant relié : ${email}`);
  } else {
    // 3. Créer l'utilisateur + compte email/password au format Better Auth
    userId = await createCredentialUser(db, { name, email, password });

    console.log(`✓ Admin créé : ${email}`);
  }

  // 4. Ajouter l'accès au tenant (idempotent)
  await db
    .insert(userTenants)
    .values({ userId, tenantId: tenant.id })
    .onConflictDoNothing();

  console.log(`✓ Accès au tenant : ${tenant.name} (slug: ${tenant.slug})`);
  if (domain) console.log(`  Domaine : ${domain}`);
  console.log(`  Template : ${template}`);

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
