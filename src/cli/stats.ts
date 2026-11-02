import { createDatabase } from "../db/client.ts";
import { collectDatabaseStats } from "../db/stats.ts";
import { flagBool, flagString, parseArgs } from "../lib/args.ts";
import {
  bold,
  formatBytes,
  formatNumber,
  paint,
  renderTable,
} from "../lib/format.ts";
import { branchConnectionString } from "../neon/branches.ts";

const { flags } = parseArgs(Bun.argv.slice(2));
const json = flagBool(flags, "json");
const branch = flagString(flags, "branch");
const explicitUrl = flagString(flags, "url");

const url =
  explicitUrl ??
  (branch
    ? await branchConnectionString(branch)
    : process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL);

const { client } = createDatabase(url);

try {
  const stats = await collectDatabaseStats(client);

  if (json) {
    console.log(JSON.stringify(stats, null, 2));
  } else {
    console.log("");
    console.log(bold(paint("cyan", "Database stats")));
    console.log("─".repeat(72));
    console.log(`Database   ${bold(stats.database)}`);
    console.log(`Server     ${stats.serverVersion}`);
    console.log(`Size       ${bold(formatBytes(stats.sizeBytes))}`);
    console.log(`Rows       ${formatNumber(stats.totalRows)}`);
    console.log(
      `Writes     +${formatNumber(stats.writes.inserts)} ins / ` +
        `+${formatNumber(stats.writes.updates)} upd / ` +
        `${formatNumber(stats.writes.deletes)} del ` +
        "(compute-local pg_stat_user_tables)",
    );
    console.log("");
    console.log(
      renderTable(
        ["table", "rows", "table size", "index size", "total"],
        stats.tables.map((table) => [
          table.table,
          formatNumber(table.rows),
          formatBytes(table.tableBytes),
          formatBytes(table.indexBytes),
          formatBytes(table.totalBytes),
        ]),
      ),
    );
    console.log("");
  }
} finally {
  await client.end();
}
