import { flagBool, flagString, parseArgs } from "../lib/args.ts";
import { bold, dim, paint } from "../lib/format.ts";
import { resolvePreviewContract } from "../preview/contract.ts";

const { flags } = parseArgs(Bun.argv.slice(2));
const path = flagString(flags, "path") ?? ".";
const json = flagBool(flags, "json");

function fail(error: unknown): never {
  console.error("");
  console.error(
    paint("red", error instanceof Error ? error.message : String(error)),
  );
  console.error("");
  process.exit(1);
}

const contract = await resolvePreviewContract(path).catch((error: unknown) =>
  fail(error),
);

if (json) {
  console.log(JSON.stringify(contract, null, 2));
} else {
  console.log("");
  console.log(bold(paint("cyan", "Preview contract")));
  console.log("─".repeat(72));
  console.log(`repo        ${contract.root}`);
  console.log(
    `source      ${contract.source}${contract.manifestPath ? ` (${contract.manifestPath})` : ""}`,
  );
  console.log(`runtime     ${contract.runtime}`);
  console.log(`package     ${contract.packageManager ?? "unknown"}`);
  console.log(
    `database    ${
      contract.database.required
        ? `required${contract.database.provider ? ` (${contract.database.provider})` : ""}`
        : "not required"
    }`,
  );
  console.log(`migrations  ${contract.migrationsDir ?? "none"}`);
  console.log(`env         ${contract.envRequired.join(", ") || "none"}`);
  if (contract.app) {
    console.log(`app         ${contract.app.command} :${contract.app.port}`);
  }

  console.log("");
  for (const name of ["install", "migrate", "seed", "build", "test"] as const) {
    console.log(`${name.padEnd(9)} ${contract[name] ?? dim("skipped")}`);
  }

  if (contract.warnings.length > 0) {
    console.log("");
    console.log(bold("Warnings"));
    for (const warning of contract.warnings) {
      console.log(`  • ${warning}`);
    }
  }

  console.log("");
}
