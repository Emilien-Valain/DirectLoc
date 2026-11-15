import { hashPassword } from "better-auth/crypto";
import { randomBytes } from "crypto";
import type { db } from "@/lib/db";
import { users, accounts } from "@/db/schema";

export function generateId(): string {
  return randomBytes(16).toString("base64url");
}

/** Crée un utilisateur + compte email/mot de passe au format Better Auth. Renvoie son id. */
export async function createCredentialUser(
  exec: Pick<typeof db, "insert">,
  { name, email, password }: { name: string; email: string; password: string },
): Promise<string> {
  const userId = generateId();
  const passwordHash = await hashPassword(password);
  await exec.insert(users).values({ id: userId, name, email, emailVerified: true });
  await exec.insert(accounts).values({
    id: generateId(),
    accountId: userId,
    providerId: "credential",
    userId,
    password: passwordHash,
  });
  return userId;
}
