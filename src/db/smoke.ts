import type { SqlClient } from "../db/client.ts";
import { createDatabase } from "../db/client.ts";
import { bold, dim, formatNumber, paint } from "../lib/format.ts";
import { branchConnectionString } from "../neon/branches.ts";
import { BASELINE_TABLES } from "../env/environments.ts";

export interface SmokeCheck {
  name: string;
  pass: boolean;
  detail?: string;
}

export interface SmokeInput {
  requiredTables: readonly string[];
  tables: readonly string[];
  rowCounts: Record<string, number>;
  migrationCount: number;
  writeOk: boolean;
  writeDetail?: string;
}

export interface SmokeResult {
  branch: string;
  pass: boolean;
  checks: SmokeCheck[];
  requiredTables: string[];
  tables: string[];
  rowCounts: Record<string, number>;
  migrationCount: number;
  checkedAt: string;
}

/**
 * Pure evaluation of a smoke run. Kept separate so the expectations can be
 * tested without a database.
 */
export function evaluateSmoke(input: SmokeInput): SmokeCheck[] {
  const missing = input.requiredTables.filter(
    (table) => !input.tables.includes(table),
  );
  const present = input.requiredTables.filter((table) =>
    input.tables.includes(table),
  );
  const empty = present.filter((table) => (input.rowCounts[table] ?? 0) === 0);

  return [
    {
      name: "required tables present",
      pass: missing.length === 0,
      detail:
        missing.length === 0
          ? input.requiredTables.join(", ")
          : `missing: ${missing.join(", ")}`,
    },
    {
      name: "baseline tables contain rows",
      pass: missing.length === 0 && empty.length === 0,
      detail:
        present.length === 0
          ? "no baseline tables found"
          : present
              .map(
                (table) =>
                  `${table} ${formatNumber(input.rowCounts[table] ?? 0)}`,
              )
              .join(" · "),
    },
    {
      name: "migrations recorded",
      pass: input.migrationCount > 0,
      detail: `${formatNumber(input.migrationCount)} applied`,
    },
    {
      name: "write probe rolled back",
      pass: input.writeOk,
      detail: input.writeOk
        ? "create/insert/select succeeded, then rolled back"
        : (input.writeDetail ?? "write probe failed"),
    },
  ];
}

class SmokeRollback extends Error {}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function countRows(
  client: SqlClient,
  tables: readonly string[],
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const rows = (await client.unsafe(
      `select count(*)::int as count from "${table.replace(/"/g, '""')}"`,
    )) as unknown as Array<{ count: number }>;
    counts[table] = Number(rows[0]?.count ?? 0);
  }
  return counts;
}

/**
 * Connect to a branch and verify it is usable: baseline tables exist and have
 * data, migrations are recorded, and a transactional write/read/rollback
 * succeeds without leaving anything behind.
 */
export async function runSmoke(options: {
  branch: string;
  url?: string;
  requiredTables?: readonly string[];
}): Promise<SmokeResult> {
  const requiredTables = options.requiredTables ?? BASELINE_TABLES;
  const url =
    options.url ?? (await branchConnectionString(options.branch, { pooled: false }));
  const { client } = createDatabase(url);

  try {
    const tableRows = (await client.unsafe(
      "select table_name from information_schema.tables " +
        "where table_schema = 'public' and table_type = 'BASE TABLE' " +
        "order by table_name",
    )) as unknown as Array<{ table_name: string }>;
    const tables = tableRows.map((row) => String(row.table_name));

    const present = requiredTables.filter((table) => tables.includes(table));
    const rowCounts = await countRows(client, present);

    let migrationCount = 0;
    try {
      const migrations = (await client.unsafe(
        "select count(*)::int as count from drizzle.__drizzle_migrations",
      )) as unknown as Array<{ count: number }>;
      migrationCount = Number(migrations[0]?.count ?? 0);
    } catch {
      migrationCount = 0;
    }

    let writeOk = false;
    let writeDetail: string | undefined;
    try {
      await client.begin(async (tx) => {
        await tx.unsafe(
          "create table smoke_write_probe (id integer primary key)",
        );
        await tx.unsafe("insert into smoke_write_probe (id) values (1)");
        const rows = (await tx.unsafe(
          "select count(*)::int as count from smoke_write_probe",
        )) as unknown as Array<{ count: number }>;
        if (Number(rows[0]?.count ?? 0) !== 1) {
          throw new Error("write probe returned an unexpected row count");
        }
        throw new SmokeRollback("rollback");
      });
    } catch (error) {
      if (error instanceof SmokeRollback) {
        writeOk = true;
      } else {
        writeDetail = errorMessage(error);
      }
    }

    const checks = evaluateSmoke({
      requiredTables,
      tables,
      rowCounts,
      migrationCount,
      writeOk,
      writeDetail,
    });

    return {
      branch: options.branch,
      pass: checks.every((check) => check.pass),
      checks,
      requiredTables: [...requiredTables],
      tables,
      rowCounts,
      migrationCount,
      checkedAt: new Date().toISOString(),
    };
  } finally {
    await client.end();
  }
}

export function printSmokeResult(result: SmokeResult): void {
  console.log("");
  console.log(bold(paint("cyan", `Smoke test · ${result.branch}`)));
  console.log("─".repeat(72));

  for (const check of result.checks) {
    const mark = check.pass ? paint("green", "✔") : paint("red", "✖");
    console.log(`${mark} ${check.name} ${dim(`(${check.detail ?? ""})`)}`);
  }

  console.log("");
  if (result.pass) {
    console.log(paint("green", "PASS  branch is readable, migrated, and writable."));
  } else {
    console.log(paint("red", "FAIL  branch failed one or more smoke checks."));
  }
  console.log("");
}
