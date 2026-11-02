/** Quote a Postgres identifier safely (table names read from catalogs). */
export function quoteIdent(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/** Quote a schema-qualified relation name. */
export function quoteRelation(schema: string, table: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(table)}`;
}
