import type { SqlClient } from "./client.ts";

/**
 * Minimal SQL script runner.
 *
 * Splits on semicolons outside of strings and comments. It intentionally
 * does not understand dollar-quoted function bodies; keep feature scripts
 * to plain DDL/DML (or run those through psql).
 */
export function splitStatements(script: string): string[] {
  const statements: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < script.length; index += 1) {
    const char = script[index] ?? "";
    const next = script[index + 1] ?? "";

    if (inLineComment) {
      current += char;
      if (char === "\n") inLineComment = false;
      continue;
    }

    if (inBlockComment) {
      current += char;
      if (char === "*" && next === "/") {
        current += next;
        index += 1;
        inBlockComment = false;
      }
      continue;
    }

    if (!inSingle && !inDouble) {
      if (char === "-" && next === "-") {
        current += char + next;
        index += 1;
        inLineComment = true;
        continue;
      }
      if (char === "/" && next === "*") {
        current += char + next;
        index += 1;
        inBlockComment = true;
        continue;
      }
    }

    if (char === "'" && !inDouble) {
      inSingle = !inSingle;
      current += char;
      continue;
    }

    if (char === '"' && !inSingle) {
      inDouble = !inDouble;
      current += char;
      continue;
    }

    if (char === ";" && !inSingle && !inDouble) {
      const statement = current.trim();
      if (statement) statements.push(statement);
      current = "";
      continue;
    }

    current += char;
  }

  const statement = current.trim();
  if (statement) statements.push(statement);
  return statements;
}

/** Execute every statement in a .sql file on the given connection. */
export async function applySqlFile(
  client: SqlClient,
  path: string,
): Promise<number> {
  const contents = await Bun.file(path).text();
  const statements = splitStatements(contents);

  for (const statement of statements) {
    await client.unsafe(statement);
  }

  return statements.length;
}
