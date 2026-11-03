import { flagBool, flagString, parseArgs } from "../lib/args.ts";
import { runSmoke, printSmokeResult } from "../db/smoke.ts";
import { branchConnectionString } from "../neon/branches.ts";

const { flags } = parseArgs(Bun.argv.slice(2));
const branch = flagString(flags, "branch");
const explicitUrl = flagString(flags, "url");
const json = flagBool(flags, "json");

const url =
  explicitUrl ??
  (branch
    ? await branchConnectionString(branch, { pooled: false })
    : process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL);

if (!url) {
  console.error(
    "Usage: bun run db:smoke --branch <branch> [--json]\n" +
      "   or: bun run db:smoke --url <connection-string> [--json]",
  );
  process.exit(1);
}

const label = branch ?? "DATABASE_URL";

try {
  const result = await runSmoke({ branch: label, url });
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printSmokeResult(result);
  }
  if (!result.pass) process.exitCode = 1;
} catch (error) {
  console.error(
    `\nSmoke test failed for ${label}: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
