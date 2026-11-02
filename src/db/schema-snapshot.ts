import type { SqlClient } from "./client.ts";

export interface ColumnSnapshot {
  name: string;
  dataType: string;
  nullable: boolean;
  defaultValue: string | null;
}

export interface IndexSnapshot {
  name: string;
  definition: string;
}

export interface TableSnapshot {
  schema: string;
  name: string;
  columns: ColumnSnapshot[];
  indexes: IndexSnapshot[];
}

export interface SchemaSnapshot {
  tables: TableSnapshot[];
  enums: Record<string, string[]>;
  capturedAt: string;
}

interface ColumnRow {
  table_schema: string;
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
}

interface IndexRow {
  tablename: string;
  indexname: string;
  indexdef: string;
}

interface EnumRow {
  name: string;
  values: string[];
}

/** Snapshot of tables, columns, indexes and enums in the public schema. */
export async function collectSchemaSnapshot(
  client: SqlClient,
): Promise<SchemaSnapshot> {
  const columnRows = (await client.unsafe(
    `select table_schema, table_name, column_name, data_type,
            is_nullable, column_default
       from information_schema.columns
      where table_schema = 'public'
      order by table_name, ordinal_position`,
  )) as unknown as ColumnRow[];

  const indexRows = (await client.unsafe(
    `select tablename, indexname, indexdef
       from pg_indexes
      where schemaname = 'public'
      order by tablename, indexname`,
  )) as unknown as IndexRow[];

  const enumRows = (await client.unsafe(
    `select t.typname as name,
            array_agg(e.enumlabel order by e.enumsortorder) as values
       from pg_type t
       join pg_enum e on e.enumtypid = t.oid
       join pg_namespace n on n.oid = t.typnamespace
      where n.nspname = 'public'
      group by t.typname
      order by t.typname`,
  )) as unknown as EnumRow[];

  const tables = new Map<string, TableSnapshot>();

  for (const row of columnRows) {
    const key = `${row.table_schema}.${row.table_name}`;
    let table = tables.get(key);
    if (!table) {
      table = {
        schema: row.table_schema,
        name: row.table_name,
        columns: [],
        indexes: [],
      };
      tables.set(key, table);
    }
    table.columns.push({
      name: row.column_name,
      dataType: row.data_type,
      nullable: row.is_nullable === "YES",
      defaultValue: row.column_default,
    });
  }

  for (const row of indexRows) {
    const key = `public.${row.tablename}`;
    tables.get(key)?.indexes.push({
      name: row.indexname,
      definition: row.indexdef,
    });
  }

  const enums: Record<string, string[]> = {};
  for (const row of enumRows) {
    enums[row.name] = row.values;
  }

  return {
    tables: [...tables.values()].sort((a, b) => a.name.localeCompare(b.name)),
    enums,
    capturedAt: new Date().toISOString(),
  };
}
