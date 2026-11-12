import { assertSafeCommand, safeRelPath, QaGuardError } from "./guard.ts";
import type { ToolDefinition } from "./model.ts";
import type { QaSandbox } from "./types.ts";

/**
 * The complete tool surface exposed to the QA model.
 *
 * Deliberate omissions: no network, no git mutations, no dependency changes,
 * no shell redirection, and no way to read dotenv files. A failing tool call is
 * returned to the model as text so it can recover without aborting the run.
 */

export const QA_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "list_files",
      description:
        "List repository files under an optional relative directory. Use this before searching blindly.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Relative directory, e.g. src/qa. Omit for the repository root.",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read a UTF-8 file from the repository. Output is truncated to 30,000 characters.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Repository-relative file path." },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search",
      description:
        "Search text files for a literal string (case-insensitive). Returns up to 50 matching lines.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Literal text to find." },
          path: {
            type: "string",
            description: "Optional relative directory to limit the search.",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Create or replace a file. Prefer the smallest possible edit. Never write secrets.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Repository-relative file path." },
          content: { type: "string", description: "Full file content." },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_file",
      description: "Delete a repository file. Use sparingly.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Repository-relative file path." },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description:
        "Run an allowlisted command in the sandbox, e.g. `bun test src/qa`, `bun run typecheck`, `git diff`, `rg foo src`. No network, no git mutations, no package changes.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Single-line shell command." },
          timeoutMs: {
            type: "number",
            description: "Optional timeout in milliseconds (max 300000).",
          },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_diff",
      description: "Show the unified patch of everything changed so far.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "done",
      description:
        "Finish the run. Call this exactly once, after verifying the fix. status is ok (nothing needed), fixed (patch produced), or failed (could not fix).",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "One-paragraph summary." },
          status: { type: "string", enum: ["ok", "fixed", "failed"] },
        },
        required: ["summary", "status"],
        additionalProperties: false,
      },
    },
  },
];

export interface QaToolContext {
  sandbox: QaSandbox;
  maxOutputChars: number;
  maxFileBytes: number;
  writtenBytes: number;
  changed: Set<string>;
  maxSearchFiles: number;
}

export interface QaToolResult {
  ok: boolean;
  output: string;
  filesChanged: string[];
}

export function createToolContext(
  sandbox: QaSandbox,
  options: { maxOutputChars?: number; maxFileBytes?: number; maxSearchFiles?: number } = {},
): QaToolContext {
  return {
    sandbox,
    maxOutputChars: options.maxOutputChars ?? 20_000,
    maxFileBytes: options.maxFileBytes ?? 200_000,
    writtenBytes: 0,
    changed: new Set(),
    maxSearchFiles: options.maxSearchFiles ?? 120,
  };
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new QaGuardError(`${field} must be a non-empty string`);
  }
  return value;
}

function asText(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new QaGuardError(`${field} must be a string`);
  }
  return value;
}

export function parseToolArguments(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new QaGuardError("tool arguments must be valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new QaGuardError("tool arguments must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function cap(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n… [truncated]` : text;
}

function formatCommand(result: Awaited<ReturnType<QaSandbox["run"]>>): string {
  const lines = [
    `$ ${result.command}`,
    `exit ${result.exitCode}${result.timedOut ? " (timed out)" : ""}${result.cancelled ? " (cancelled)" : ""} · ${result.durationMs}ms`,
  ];
  if (result.stdout) lines.push("--- stdout ---", result.stdout);
  if (result.stderr) lines.push("--- stderr ---", result.stderr);
  return lines.join("\n");
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  context: QaToolContext,
): Promise<QaToolResult> {
  try {
    switch (name) {
      case "list_files": {
        const path = typeof args.path === "string" ? args.path : "";
        const files = await context.sandbox.list(path);
        const output =
          files.length === 0
            ? "(no files)"
            : cap(files.join("\n"), context.maxOutputChars);
        return { ok: true, output, filesChanged: [] };
      }

      case "read_file": {
        const path = asString(args.path, "path");
        const content = await context.sandbox.read(path);
        return { ok: true, output: content, filesChanged: [] };
      }

      case "search": {
        const query = asString(args.query, "query");
        const path = typeof args.path === "string" ? args.path : "";
        const files = (await context.sandbox.list(path)).slice(
          0,
          context.maxSearchFiles,
        );
        const needle = query.toLowerCase();
        const matches: string[] = [];

        for (const file of files) {
          if (matches.length >= 50) break;
          let content: string;
          try {
            content = await context.sandbox.read(file, { maxChars: 120_000 });
          } catch {
            continue;
          }
          const lines = content.split(/\r?\n/);
          for (let index = 0; index < lines.length; index += 1) {
            const line = lines[index] ?? "";
            if (!line.toLowerCase().includes(needle)) continue;
            matches.push(`${file}:${index + 1}: ${line.trim().slice(0, 240)}`);
            if (matches.length >= 50) break;
          }
        }

        return {
          ok: true,
          output: matches.length === 0 ? "(no matches)" : cap(matches.join("\n"), context.maxOutputChars),
          filesChanged: [],
        };
      }

      case "write_file": {
        const path = asString(args.path, "path");
        const content = asText(args.content, "content");
        const rel = safeRelPath(path);
        if (!rel) throw new QaGuardError("path is required");

        const bytes = Buffer.byteLength(content, "utf8");
        if (context.writtenBytes + bytes > context.maxFileBytes) {
          throw new QaGuardError(
            `write budget exceeded (${context.writtenBytes + bytes} > ${context.maxFileBytes} bytes)`,
          );
        }

        await context.sandbox.write(rel, content);
        context.writtenBytes += bytes;
        context.changed.add(rel);
        return {
          ok: true,
          output: `wrote ${rel} (${bytes} bytes)`,
          filesChanged: [rel],
        };
      }

      case "delete_file": {
        const path = asString(args.path, "path");
        const rel = safeRelPath(path);
        if (!rel) throw new QaGuardError("path is required");
        await context.sandbox.remove(rel);
        context.changed.add(rel);
        return { ok: true, output: `deleted ${rel}`, filesChanged: [rel] };
      }

      case "run_command": {
        const command = assertSafeCommand(asString(args.command, "command"));
        const timeoutMs =
          typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs)
            ? Math.min(Math.max(args.timeoutMs, 1_000), 300_000)
            : 180_000;
        const result = await context.sandbox.run(command, { timeoutMs });
        const output = cap(formatCommand(result), context.maxOutputChars);
        return {
          ok: result.exitCode === 0 && !result.timedOut,
          output,
          filesChanged: [],
        };
      }

      case "git_diff": {
        const patch = await context.sandbox.diff();
        return {
          ok: true,
          output: patch.trim() ? cap(patch, context.maxOutputChars * 2) : "(no changes)",
          filesChanged: [],
        };
      }

      case "done": {
        const summary = asString(args.summary, "summary");
        const status = args.status;
        if (status !== "ok" && status !== "fixed" && status !== "failed") {
          throw new QaGuardError("status must be ok, fixed, or failed");
        }
        return {
          ok: status !== "failed",
          output: `done (${status}): ${summary}`,
          filesChanged: [],
        };
      }

      default:
        return {
          ok: false,
          output: `unknown tool: ${name}`,
          filesChanged: [],
        };
    }
  } catch (error) {
    return {
      ok: false,
      output: `error: ${error instanceof Error ? error.message : String(error)}`,
      filesChanged: [],
    };
  }
}
