import { createDatabase } from "../db/client.ts";
import { diffSchemas, type SchemaDiff } from "../db/diff.ts";
import { collectSchemaSnapshot } from "../db/schema-snapshot.ts";
import {
  collectDatabaseStats,
  type DatabaseStats,
  type WriteActivity,
} from "../db/stats.ts";
import {
  bold,
  dim,
  formatBytes,
  formatBytesDelta,
  formatDate,
  formatNumber,
  formatSigned,
  paint,
  renderTable,
} from "../lib/format.ts";
import {
  branchConnectionString,
  listBranches,
  neonSchemaDiff,
  type NeonBranch,
} from "./branches.ts";
import { parentBranchName } from "./cli.ts";

export interface TableComparison {
  table: string;
  baseRows: number;
  branchRows: number;
  rowDelta: number;
  baseBytes: number;
  branchBytes: number;
  byteDelta: number;
}

export interface BranchReport {
  mode: "neon" | "direct";
  branch: {
    name: string;
    id?: string;
    state?: string;
    createdAt?: string;
    writtenDataBytes?: number;
    cpuUsedSec?: number;
  };
  parent: {
    name: string;
    id?: string;
    state?: string;
    createdAt?: string;
  };
  base: DatabaseStats;
  compare: DatabaseStats;
  sizeDeltaBytes: number;
  rowDelta: number;
  branchWrites: WriteActivity;
  tables: TableComparison[];
  schemaDiff: SchemaDiff;
  neonSchemaDiff: string | null;
  capturedAt: string;
}

export interface ReportOptions {
  branch?: string;
  parent?: string;
  baseUrl?: string;
  branchUrl?: string;
  /** Include Neon's own schema-diff output. Defaults to true in Neon mode. */
  neonDiff?: boolean;
}

interface ReportContext {
  branchMeta?: NeonBranch;
  parentMeta?: NeonBranch;
  branchUrl: string;
  baseUrl: string;
  mode: "neon" | "direct";
}

async function resolveContext(options: ReportOptions): Promise<ReportContext> {
  if (options.baseUrl && options.branchUrl) {
    return {
      mode: "direct",
      branchUrl: options.branchUrl,
      baseUrl: options.baseUrl,
    };
  }

  const branchName = options.branch ?? process.env.NEON_BRANCH;
  if (!branchName) {
    throw new Error(
      "No branch named. Pass a branch name, or pass both --base-url and --branch-url.",
    );
  }

  const parentName = options.parent ?? parentBranchName();
  const branches = await listBranches();
  const branchMeta = branches.find((branch) => branch.name === branchName);
  const parentMeta = branches.find((branch) => branch.name === parentName);

  if (!branchMeta) {
    throw new Error(
      `Branch "${branchName}" was not found. Run \`bun run branch:list\` to see available branches.`,
    );
  }

  if (!parentMeta) {
    throw new Error(
      `Parent branch "${parentName}" was not found. Run \`bun run branch:list\` to see available branches.`,
    );
  }

  // If the local env already points at one of the two branches, reuse it
  // instead of paying for another Neon CLI round trip.
  const envBranch = process.env.NEON_BRANCH;
  const envUrl = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;

  const [branchUrl, baseUrl] = await Promise.all([
    envBranch === branchName && envUrl
      ? envUrl
      : branchConnectionString(branchName, { pooled: true }),
    envBranch === parentName && envUrl
      ? envUrl
      : branchConnectionString(parentName, { pooled: true }),
  ]);

  return {
    mode: "neon",
    branchMeta,
    parentMeta,
    branchUrl,
    baseUrl,
  };
}

function compareTables(base: DatabaseStats, compare: DatabaseStats): TableComparison[] {
  const baseTables = new Map(base.tables.map((table) => [table.table, table]));
  const compareTables = new Map(compare.tables.map((table) => [table.table, table]));
  const names = new Set([...baseTables.keys(), ...compareTables.keys()]);

  return [...names]
    .sort()
    .map((name) => {
      const baseTable = baseTables.get(name);
      const compareTable = compareTables.get(name);
      const baseRows = baseTable?.rows ?? 0;
      const branchRows = compareTable?.rows ?? 0;
      const baseBytes = baseTable?.totalBytes ?? 0;
      const branchBytes = compareTable?.totalBytes ?? 0;
      return {
        table: name,
        baseRows,
        branchRows,
        rowDelta: branchRows - baseRows,
        baseBytes,
        branchBytes,
        byteDelta: branchBytes - baseBytes,
      };
    });
}

export async function buildBranchReport(
  options: ReportOptions = {},
): Promise<BranchReport> {
  const context = await resolveContext(options);

  const baseHandle = createDatabase(context.baseUrl);
  const branchHandle = createDatabase(context.branchUrl);

  try {
    const [baseStats, compareStats, baseSnapshot, compareSnapshot] =
      await Promise.all([
        collectDatabaseStats(baseHandle.client),
        collectDatabaseStats(branchHandle.client),
        collectSchemaSnapshot(baseHandle.client),
        collectSchemaSnapshot(branchHandle.client),
      ]);

    const schemaDiff = diffSchemas(baseSnapshot, compareSnapshot);
    const branchName = context.branchMeta?.name ?? options.branch ?? "branch";
    const parentName =
      context.parentMeta?.name ?? options.parent ?? "parent";

    const neonDiff =
      context.mode === "neon" && options.neonDiff === true
        ? await neonSchemaDiff(parentName, branchName)
        : null;

    return {
      mode: context.mode,
      branch: {
        name: branchName,
        id: context.branchMeta?.id,
        state: context.branchMeta?.currentState,
        createdAt: context.branchMeta?.createdAt,
        writtenDataBytes: context.branchMeta?.writtenDataBytes,
        cpuUsedSec: context.branchMeta?.cpuUsedSec,
      },
      parent: {
        name: parentName,
        id: context.parentMeta?.id,
        state: context.parentMeta?.currentState,
        createdAt: context.parentMeta?.createdAt,
      },
      base: baseStats,
      compare: compareStats,
      sizeDeltaBytes: compareStats.sizeBytes - baseStats.sizeBytes,
      rowDelta: compareStats.totalRows - baseStats.totalRows,
      branchWrites: compareStats.writes,
      tables: compareTables(baseStats, compareStats),
      schemaDiff,
      neonSchemaDiff: neonDiff,
      capturedAt: new Date().toISOString(),
    };
  } finally {
    await Promise.all([baseHandle.client.end(), branchHandle.client.end()]);
  }
}

export function printBranchReport(report: BranchReport): void {
  const line = "─".repeat(72);
  console.log("");
  console.log(bold(paint("cyan", "Database branch report")));
  console.log(line);
  console.log(`Branch      ${bold(report.branch.name)}${report.branch.id ? dim(` (${report.branch.id})`) : ""}`);
  console.log(`State       ${report.branch.state ?? "n/a"}`);
  console.log(`Parent      ${report.parent.name}`);
  console.log(`Created     ${formatDate(report.branch.createdAt)}`);
  console.log(`Captured    ${formatDate(report.capturedAt)}`);
  console.log(`Mode        ${report.mode === "neon" ? "Neon branch (copy-on-write)" : "direct connection pair"}`);

  if (typeof report.branch.writtenDataBytes === "number") {
    const note =
      report.branch.writtenDataBytes === 0
        ? "(Neon metric reported 0 B; it can lag — see branch writes)"
        : "(Neon written_data_bytes)";
    console.log(
      `COW writes  ${bold(formatBytes(report.branch.writtenDataBytes))} ${dim(note)}`,
    );
  }

  console.log("");
  console.log(bold("Storage"));
  console.log(line);
  console.log(`Parent size   ${formatBytes(report.base.sizeBytes)}`);
  console.log(`Branch size   ${formatBytes(report.compare.sizeBytes)}`);
  console.log(`Delta         ${paintDelta(report.sizeDeltaBytes)}`);
  console.log(
    `Rows          ${formatNumber(report.base.totalRows)} → ${formatNumber(report.compare.totalRows)} ` +
      `(${paintDeltaText(formatSigned(report.rowDelta), report.rowDelta)})`,
  );
  console.log(
    `Branch writes +${formatNumber(report.branchWrites.inserts)} ins / ` +
      `+${formatNumber(report.branchWrites.updates)} upd / ` +
      `${formatNumber(report.branchWrites.deletes)} del ` +
      dim("(compute-local pg_stat_user_tables)"),
  );

  console.log("");
  console.log(bold("Tables"));
  console.log(line);

  const rows = report.tables.map((table) => [
    table.table,
    formatNumber(table.baseRows),
    formatNumber(table.branchRows),
    formatSigned(table.rowDelta),
    formatBytes(table.baseBytes),
    formatBytes(table.branchBytes),
    formatBytesDelta(table.byteDelta),
  ]);

  console.log(
    renderTable(
      ["table", "rows base", "rows branch", "Δ rows", "size base", "size branch", "Δ size"],
      rows,
    ),
  );

  console.log("");
  console.log(bold("Schema changes (information_schema diff)"));
  console.log(line);
  printSchemaDiff(report.schemaDiff);

  if (report.neonSchemaDiff) {
    console.log("");
    console.log(bold("Schema changes (neon branch schema-diff)"));
    console.log(line);
    console.log(report.neonSchemaDiff);
  }

  console.log("");
}

function paintDelta(value: number): string {
  const text = formatBytesDelta(value);
  if (value > 0) return paint("yellow", text);
  if (value < 0) return paint("green", text);
  return dim(text);
}

function paintDeltaText(text: string, value: number): string {
  if (value > 0) return paint("yellow", text);
  if (value < 0) return paint("green", text);
  return dim(text);
}

function printSchemaDiff(diff: SchemaDiff): void {
  if (!diff.hasChanges) {
    console.log(dim("No schema differences."));
    return;
  }

  for (const table of diff.tablesAdded) {
    console.log(paint("green", `+ table ${table}`));
  }
  for (const table of diff.tablesRemoved) {
    console.log(paint("red", `- table ${table}`));
  }

  for (const change of diff.tablesChanged) {
    console.log(paint("yellow", `~ table ${change.table}`));
    for (const column of change.columnsAdded) {
      console.log(paint("green", `    + column ${column}`));
    }
    for (const column of change.columnsRemoved) {
      console.log(paint("red", `    - column ${column}`));
    }
    for (const column of change.columnsChanged) {
      console.log(
        paint("yellow", `    ~ column ${column.name} (${column.field})`),
        dim(`${column.before} → ${column.after}`),
      );
    }
    for (const index of change.indexesAdded) {
      console.log(paint("green", `    + index ${index}`));
    }
    for (const index of change.indexesRemoved) {
      console.log(paint("red", `    - index ${index}`));
    }
  }

  for (const name of diff.enumsAdded) {
    console.log(paint("green", `+ enum ${name}`));
  }
  for (const name of diff.enumsRemoved) {
    console.log(paint("red", `- enum ${name}`));
  }
  for (const change of diff.enumsChanged) {
    console.log(paint("yellow", `~ enum ${change.name}`));
    for (const value of change.added) {
      console.log(paint("green", `    + value ${value}`));
    }
    for (const value of change.removed) {
      console.log(paint("red", `    - value ${value}`));
    }
  }
}


