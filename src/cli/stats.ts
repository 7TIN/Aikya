import { createDatabase } from "../db/client.ts";
import { collectDatabaseStats } from "../db/stats.ts";
import {
  bold,
  formatBytes,
  formatNumber,
  paint,
  renderTable,
} from "../lib/format.ts";

const json = Bun.argv.includes("--json");

const { client } = createDatabase(
  process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL,
);

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
