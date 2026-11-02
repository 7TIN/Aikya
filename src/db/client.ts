import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.ts";

export type SqlClient = ReturnType<typeof postgres>;
export type Database = ReturnType<typeof createDatabase>["db"];

export interface DatabaseHandle {
  client: SqlClient;
  db: ReturnType<typeof drizzle<typeof schema>>;
}

/**
 * Create an isolated handle. Used by scripts that need more than one
 * connection at a time (for example: compare a branch with its parent).
 */
export function createDatabase(url: string | undefined = process.env.DATABASE_URL): DatabaseHandle {
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env.local and add your Neon connection string.",
    );
  }

  const client = postgres(url, {
    // Neon's pooled endpoint sits behind PgBouncer, so prepared statements
    // must stay disabled. It also keeps the same code working with a plain
    // local Postgres.
    prepare: false,
    max: Number(process.env.DB_POOL_SIZE ?? 5),
    idle_timeout: 20,
    connect_timeout: 15,
    onnotice: () => {},
  });

  return {
    client,
    db: drizzle(client, { schema }),
  };
}

let cached: DatabaseHandle | undefined;

/** Shared handle for the Bun server. */
export function getDatabase(): DatabaseHandle {
  cached ??= createDatabase();
  return cached;
}

export async function closeDatabase(): Promise<void> {
  if (!cached) return;
  await cached.client.end();
  cached = undefined;
}
