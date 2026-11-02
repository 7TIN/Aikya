import type {
  SchemaSnapshot,
  TableSnapshot,
} from "./schema-snapshot.ts";

export interface ColumnChange {
  name: string;
  field: "type" | "nullable" | "default";
  before: string;
  after: string;
}

export interface TableChange {
  table: string;
  columnsAdded: string[];
  columnsRemoved: string[];
  columnsChanged: ColumnChange[];
  indexesAdded: string[];
  indexesRemoved: string[];
}

export interface EnumChange {
  name: string;
  added: string[];
  removed: string[];
}

export interface SchemaDiff {
  tablesAdded: string[];
  tablesRemoved: string[];
  tablesChanged: TableChange[];
  enumsAdded: string[];
  enumsRemoved: string[];
  enumsChanged: EnumChange[];
  hasChanges: boolean;
}

function tableMap(snapshot: SchemaSnapshot): Map<string, TableSnapshot> {
  return new Map(snapshot.tables.map((table) => [table.name, table]));
}

function diffTable(before: TableSnapshot, after: TableSnapshot): TableChange | null {
  const beforeColumns = new Map(before.columns.map((column) => [column.name, column]));
  const afterColumns = new Map(after.columns.map((column) => [column.name, column]));

  const columnsAdded = [...afterColumns.keys()].filter((name) => !beforeColumns.has(name));
  const columnsRemoved = [...beforeColumns.keys()].filter((name) => !afterColumns.has(name));
  const columnsChanged: ColumnChange[] = [];

  for (const [name, beforeColumn] of beforeColumns) {
    const afterColumn = afterColumns.get(name);
    if (!afterColumn) continue;

    if (beforeColumn.dataType !== afterColumn.dataType) {
      columnsChanged.push({
        name,
        field: "type",
        before: beforeColumn.dataType,
        after: afterColumn.dataType,
      });
    }
    if (beforeColumn.nullable !== afterColumn.nullable) {
      columnsChanged.push({
        name,
        field: "nullable",
        before: beforeColumn.nullable ? "null" : "not null",
        after: afterColumn.nullable ? "null" : "not null",
      });
    }
    if (beforeColumn.defaultValue !== afterColumn.defaultValue) {
      columnsChanged.push({
        name,
        field: "default",
        before: beforeColumn.defaultValue ?? "none",
        after: afterColumn.defaultValue ?? "none",
      });
    }
  }

  const beforeIndexes = new Set(before.indexes.map((index) => index.name));
  const afterIndexes = new Set(after.indexes.map((index) => index.name));
  const indexesAdded = [...afterIndexes].filter((name) => !beforeIndexes.has(name));
  const indexesRemoved = [...beforeIndexes].filter((name) => !afterIndexes.has(name));

  const changed =
    columnsAdded.length > 0 ||
    columnsRemoved.length > 0 ||
    columnsChanged.length > 0 ||
    indexesAdded.length > 0 ||
    indexesRemoved.length > 0;

  if (!changed) return null;

  return {
    table: before.name,
    columnsAdded,
    columnsRemoved,
    columnsChanged,
    indexesAdded,
    indexesRemoved,
  };
}

/** Compare a base schema (parent branch) with a compare schema (child branch). */
export function diffSchemas(base: SchemaSnapshot, compare: SchemaSnapshot): SchemaDiff {
  const baseTables = tableMap(base);
  const compareTables = tableMap(compare);

  const tablesAdded = [...compareTables.keys()].filter((name) => !baseTables.has(name));
  const tablesRemoved = [...baseTables.keys()].filter((name) => !compareTables.has(name));

  const tablesChanged: TableChange[] = [];
  for (const [name, baseTable] of baseTables) {
    const compareTable = compareTables.get(name);
    if (!compareTable) continue;
    const change = diffTable(baseTable, compareTable);
    if (change) tablesChanged.push(change);
  }

  const enumsAdded = Object.keys(compare.enums).filter((name) => !(name in base.enums));
  const enumsRemoved = Object.keys(base.enums).filter((name) => !(name in compare.enums));
  const enumsChanged: EnumChange[] = [];

  for (const [name, baseValues] of Object.entries(base.enums)) {
    const compareValues = compare.enums[name];
    if (!compareValues) continue;
    const added = compareValues.filter((value) => !baseValues.includes(value));
    const removed = baseValues.filter((value) => !compareValues.includes(value));
    if (added.length > 0 || removed.length > 0) {
      enumsChanged.push({ name, added, removed });
    }
  }

  return {
    tablesAdded: tablesAdded.sort(),
    tablesRemoved: tablesRemoved.sort(),
    tablesChanged: tablesChanged.sort((a, b) => a.table.localeCompare(b.table)),
    enumsAdded,
    enumsRemoved,
    enumsChanged,
    hasChanges:
      tablesAdded.length > 0 ||
      tablesRemoved.length > 0 ||
      tablesChanged.length > 0 ||
      enumsAdded.length > 0 ||
      enumsRemoved.length > 0 ||
      enumsChanged.length > 0,
  };
}
