import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDatabase } from "./client.ts";

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

export async function runMigrations(
  db: Parameters<typeof migrate>[0],
): Promise<void> {
  await migrate(db, { migrationsFolder });
}

if (import.meta.main) {
  const { client, db } = createDatabase(
    process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL,
  );
  try {
    console.log("Applying migrations...");
    await runMigrations(db);
    console.log("✔ Migrations applied.");
  } finally {
    await client.end();
  }
}
