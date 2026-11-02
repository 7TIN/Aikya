import { fileURLToPath } from "node:url";
import { createDatabase } from "../db/client.ts";
import { applySqlFile } from "../db/sql-file.ts";
import { flagBool, flagString, parseArgs } from "../lib/args.ts";
import { bold, dim, formatBytes, formatDate, paint } from "../lib/format.ts";
import {
  branchConnectionString,
  createBranch,
  deleteBranch,
} from "../neon/branches.ts";
import { parentBranchName } from "../neon/cli.ts";
import { buildBranchReport, printBranchReport } from "../neon/report.ts";

const featureSql = fileURLToPath(
  new URL("../db/features/001-coupons.sql", import.meta.url),
);
const dataSql = fileURLToPath(
  new URL("../db/features/002-coupons-data.sql", import.meta.url),
);

const { flags } = parseArgs(Bun.argv.slice(2));
const branchName = flagString(flags, "name") ?? "demo-coupons";
const parent = flagString(flags, "parent") ?? parentBranchName();
const reuse = flagBool(flags, "reuse");
const cleanup = flagBool(flags, "cleanup");
const json = flagBool(flags, "json");

async function baselineIsSeeded(): Promise<boolean> {
  const { client } = createDatabase(
    process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL,
  );
  try {
    const rows = (await client.unsafe(
      "select count(*)::int as count from customers",
    )) as unknown as Array<{ count: number }>;
    return (rows[0]?.count ?? 0) > 0;
  } catch {
    return false;
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  if (!(await baselineIsSeeded())) {
    throw new Error(
      "The baseline database has no data (or no schema). Run `bun run db:reset` first, " +
        "then re-run the demo.",
    );
  }

  let branch = reuse
    ? { name: branchName }
    : await (async () => {
        console.log(`Creating branch ${bold(branchName)} from ${parent}...`);
        return createBranch({ name: branchName, parent });
      })();

  if (!reuse && "currentState" in branch) {
    console.log(
      paint("green", `✔ Branch ${branch.name} is ${branch.currentState}`) +
        `  ${dim(`(created ${formatDate(branch.createdAt)})`)}`,
    );
  } else {
    console.log(`Using existing branch ${bold(branch.name)}.`);
  }

  const url = await branchConnectionString(branch.name, { pooled: true });
  const handle = createDatabase(url);

  try {
    console.log(`Applying branch-only feature migration: ${dim("001-coupons.sql")}`);
    const ddl = await applySqlFile(handle.client, featureSql);
    console.log(`Applying branch-only seed data: ${dim("002-coupons-data.sql")}`);
    const dml = await applySqlFile(handle.client, dataSql);
    console.log(`✔ Applied ${ddl + dml} statements to ${branch.name}`);
  } finally {
    await handle.client.end();
  }

  const report = await buildBranchReport({
    branch: branch.name,
    parent,
  });

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printBranchReport(report);
  }

  if (cleanup) {
    await deleteBranch(branch.name);
    console.log(paint("green", `✔ Deleted branch ${branch.name}`));
    return;
  }

  console.log(dim("Branch left in place for inspection."));
  console.log(dim(`  bun run branch:report ${branch.name}`));
  console.log(dim(`  bun run branch:delete ${branch.name} --yes`));
  if (typeof report.branch.writtenDataBytes === "number") {
    console.log(
      report.branch.writtenDataBytes > 0
        ? dim(`Neon reports ${formatBytes(report.branch.writtenDataBytes)} of branch-local writes.`)
        : dim("Neon reported 0 B of written_data_bytes (the metric can lag; see branch writes)."),
    );
  }
  console.log("");
}

main().catch((error: unknown) => {
  console.error("");
  console.error(paint("red", error instanceof Error ? error.message : String(error)));
  console.error("");
  process.exit(1);
});
