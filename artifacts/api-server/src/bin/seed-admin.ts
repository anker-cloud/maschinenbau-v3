/**
 * Deterministic admin-seeding command. Run as part of bootstrap or after a
 * migration to guarantee an initial admin exists.
 *
 *   pnpm --filter @workspace/api-server run seed-admin
 *
 * Reads SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD, SEED_ADMIN_NAME from env. In
 * production all three must be set or the command exits 1. In development the
 * defaults below are used. The command is idempotent: if a user with the
 * given email already exists, it is left unchanged.
 */
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { hashPassword } from "../lib/auth";

async function main(): Promise<void> {
  const isProd = process.env.NODE_ENV === "production";
  const email = (process.env.SEED_ADMIN_EMAIL || (isProd ? "" : "admin@sturtz.com")).toLowerCase().trim();
  const password = process.env.SEED_ADMIN_PASSWORD || (isProd ? "" : "changeme123");
  const name = process.env.SEED_ADMIN_NAME || "Admin";

  if (!email || !password) {
    console.error(
      "seed-admin: SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD must be set in production.",
    );
    process.exit(1);
  }

  const [existing] = await db.select().from(usersTable).where(eq(usersTable.email, email));
  if (existing) {
    console.log(`seed-admin: user ${email} already exists; no changes.`);
    return;
  }
  const passwordHash = await hashPassword(password);
  await db.insert(usersTable).values({ email, name, passwordHash, role: "admin" });
  console.log(`seed-admin: created admin user ${email}.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("seed-admin: failed", err);
    process.exit(1);
  });
