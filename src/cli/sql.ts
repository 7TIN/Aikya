import { createDatabase } from "../db/client.ts";
import { applySqlFile } from "../db/sql-file.ts";
import { flagString, parseArgs } from "../lib/args.ts";
import { branchConnectionString } from "../neon/branches.ts";

const { flags, positional } = parseArgs(Bun.argv.slice(2));
const file = positional[0];

if (!file) {
  console.error(
    "Usage: bun run db:sql <file.sql> [--branch <name>] [--url <connection-string>]",
  );
  process.exit(1);
}

const branch = flagString(flags, "branch");
const explicitUrl = flagString(flags, "url");

const url =
  explicitUrl ??
  (branch ? await branchConnectionString(branch) : process.env.DATABASE_URL);

if (!url) {
  console.error("No connection: set DATABASE_URL, or pass --branch / --url.");
  process.exit(1);
}

const { client } = createDatabase(url);
try {
  const count = await applySqlFile(client, file);
  console.log(`✔ Applied ${count} statement(s) from ${file}`);
} finally {
  await client.end();
}
