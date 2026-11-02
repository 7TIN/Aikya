import type { SqlClient } from "./client.ts";
import { quoteRelation } from "./sql-utils.ts";

export interface TableStats {
  schema: string;
  table: string;
  rows: number;
  totalBytes: number;
  tableBytes: number;
  indexBytes: number;
}

export interface DatabaseStats {
  database: string;
  serverVersion: string;
  sizeBytes: number;
  tables: TableStats[];
  totalRows: number;
  capturedAt: string;
}

interface DatabaseInfoRow {
  database: string;
  version: string;
  size: string;
}

interface TableSizeRow {
  schema: string;
  table: string;
  total: string;
  table_size: string;
  index_size: string;
}

/**
 * Collects storage + row information for a single database.
 *
 * Rows are counted exactly (fine for demo-sized data). On large databases
 * switch to reltuples estimates or pg_stat_user_tables.
 */
export async function collectDatabaseStats(
  client: SqlClient,
): Promise<DatabaseStats> {
  const [info] = (await client.unsafe(
    `select current_database() as database,
            version() as version,
            pg_database_size(current_database())::text as size`,
  )) as unknown as DatabaseInfoRow[];

  if (!info) throw new Error("Could not read database information");

  const tableRows = (await client.unsafe(
    `select n.nspname as schema,
            c.relname as "table",
            pg_total_relation_size(c.oid)::text as total,
            pg_relation_size(c.oid)::text as table_size,
            pg_indexes_size(c.oid)::text as index_size
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where c.relkind = 'r'
        and n.nspname = 'public'
      order by pg_total_relation_size(c.oid) desc`,
  )) as unknown as TableSizeRow[];

  const tables: TableStats[] = [];
  for (const row of tableRows) {
    const relation = quoteRelation(row.schema, row.table);
    const countRows = (await client.unsafe(
      `select count(*)::int as count from ${relation}`,
    )) as unknown as Array<{ count: number }>;

    tables.push({
      schema: row.schema,
      table: row.table,
      rows: countRows[0]?.count ?? 0,
      totalBytes: Number(row.total),
      tableBytes: Number(row.table_size),
      indexBytes: Number(row.index_size),
    });
  }

  return {
    database: info.database,
    serverVersion: info.version.split(",")[0] ?? info.version,
    sizeBytes: Number(info.size),
    tables,
    totalRows: tables.reduce((sum, table) => sum + table.rows, 0),
    capturedAt: new Date().toISOString(),
  };
}
