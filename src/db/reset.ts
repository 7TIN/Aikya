import { createDatabase } from "./client.ts";
import { runMigrations } from "./migrate.ts";
import { seedDatabase } from "./seed.ts";

/**
 * Drop everything in the public schema, re-run migrations, then seed.
 * Intended for local/dev databases and throwaway Neon branches only.
 */
const { client, db } = createDatabase(
  process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL,
);

try {
  console.log("Resetting public schema...");
  await client.unsafe(
    'drop schema if exists "public" cascade;' +
      'drop schema if exists "drizzle" cascade;' +
      'create schema "public";',
  );
  await runMigrations(db);
  const result = await seedDatabase(db, client);
  console.log(
    `✔ Reset complete: ${result.customers} customers, ${result.products} products, ` +
      `${result.orders} orders, ${result.orderItems} order items.`,
  );
} finally {
  await client.end();
}
