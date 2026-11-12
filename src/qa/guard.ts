import { relative, resolve, sep } from "node:path";

/**
 * Guards shared by every QA tool.
 *
 * These are not a substitute for the Vercel Sandbox boundary, but they keep the
 * local workspace honest: the agent cannot wander outside the checkout, read
 * dotenv files, or rewrite git history.
 */

export class QaGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QaGuardError";
  }
}

const BLOCKED_SEGMENTS = new Set([
  ".git",
  ".next",
  ".vercel",
  "artifacts",
  "coverage",
  "dist",
  "node_modules",
  "out",
]);

const BLOCKED_FILE = /^\.env(\..*)?$/i;

/**
 * Validate a repository-relative path and return it with forward slashes.
 * An empty string means the repository root (only useful for `list_files`).
 */
export function safeRelPath(raw: string): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new QaGuardError("path is required");
  }

  const normalized = raw.replace(/\\/g, "/").trim();
  if (normalized === "." || normalized === "./") return "";
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
    throw new QaGuardError(`absolute paths are not allowed: ${raw}`);
  }

  const parts: string[] = [];
  for (const part of normalized.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      throw new QaGuardError(`path traversal is not allowed: ${raw}`);
    }
    parts.push(part);
  }

  if (parts.length === 0) return "";

  for (const part of parts) {
    if (BLOCKED_SEGMENTS.has(part.toLowerCase())) {
      throw new QaGuardError(`path is outside the editable workspace: ${raw}`);
    }
  }

  const base = parts[parts.length - 1] ?? "";
  if (BLOCKED_FILE.test(base)) {
    throw new QaGuardError(`dotenv files are not readable: ${raw}`);
  }

  return parts.join("/");
}

/** Resolve a validated relative path under `root` and re-check containment. */
export function resolveInside(root: string, rel: string): string {
  const base = resolve(root);
  const abs = resolve(base, ...rel.split("/").filter(Boolean));
  if (abs !== base && !abs.startsWith(base + sep)) {
    throw new QaGuardError(`path escapes the workspace: ${rel}`);
  }
  return abs;
}

export function relativeTo(root: string, abs: string): string {
  return relative(root, abs).split(sep).join("/");
}

/**
 * Commands the agent may run. Everything else is rejected before it reaches a
 * shell. Read-only inspection is welcome; mutation goes through `write_file`
 * and `delete_file`, and dependency changes are intentionally impossible.
 */
const ALLOWED_COMMANDS: RegExp[] = [
  /^bun\s+(install|test|check|--version)\b/,
  /^bun\s+run\s+(typecheck|build|test|check)\b/,
  /^git\s+(status|diff|log|show|ls-files|blame)\b/,
  /^(ls|dir|find|rg|grep|cat|head|tail|wc|sed|awk|sort|uniq|file|stat)\b/,
];

const DENIED_COMMANDS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /\bgit\s+(push|commit|reset|clean|checkout|switch|tag|remote|config|add|rm|mv)\b/,
    reason: "git mutations are not allowed",
  },
  {
    pattern: /\b(npm|pnpm|yarn)\s+(publish|add|remove|install|upgrade|update)\b/,
    reason: "package manager changes are not allowed",
  },
  {
    pattern: /\bbun\s+(add|remove|publish|x|create|update|upgrade)\b/,
    reason: "dependency changes are not allowed",
  },
  {
    pattern: /^\s*(gh|neon|psql|pg_dump|vercel|wrangler|aws|gcloud|az)\b/,
    reason: "cloud and GitHub CLIs are not available in QA",
  },
  {
    pattern: /\bbun\s+run\s+(branch:delete|branch:reap|branch:reset|ci:cleanup|db:reset|db:seed|dev|start)\b/,
    reason: "destructive or long-running scripts are not allowed",
  },
  {
    pattern: /\b(rm|rmdir|del|erase|mv|move|cp|copy|chmod|chown|sudo)\b/,
    reason: "use write_file/delete_file instead of shell mutation",
  },
  {
    pattern: /\b(curl|wget|invoke-webrequest|invoke-restmethod|nc|ssh|scp)\b/i,
    reason: "network commands are not allowed",
  },
  {
    pattern: /^\s*(env|printenv|set|export)\b/,
    reason: "environment dumps are not allowed",
  },
  {
    pattern: /\bsed\s+(-[a-z]*i|--in-place)\b/,
    reason: "in-place edits must use write_file",
  },
  {
    pattern: /\b(find|rg|grep)\b[^\n]*\s(-delete|-exec|-execdir)\b/,
    reason: "destructive find/grep flags are not allowed",
  },
];

/** Reject commands that are unsafe or outside the QA allowlist. */
export function assertSafeCommand(raw: string): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new QaGuardError("command is required");
  }
  if (raw.length > 4_000) {
    throw new QaGuardError("command is too long");
  }
  if (raw.includes("\n") || raw.includes("\r") || raw.includes("\0")) {
    throw new QaGuardError("multi-line commands are not allowed");
  }
  if (raw.includes("..")) {
    throw new QaGuardError("path traversal is not allowed in commands");
  }
  if (/[;&|`$<>]/.test(raw)) {
    throw new QaGuardError("shell chaining and redirection are not allowed");
  }
  if (/(^|[\s"'=])(\/|~[\\/]|[A-Za-z]:[\\/])/.test(raw)) {
    throw new QaGuardError("absolute paths are not allowed in commands");
  }
  if (/\.env(\b|\.)/i.test(raw)) {
    throw new QaGuardError("dotenv files are not readable");
  }

  const command = raw.trim();
  if (!ALLOWED_COMMANDS.some((pattern) => pattern.test(command))) {
    throw new QaGuardError(
      `command is not allowlisted: ${command.split(/\s+/)[0]}`,
    );
  }

  for (const rule of DENIED_COMMANDS) {
    if (rule.pattern.test(command)) {
      throw new QaGuardError(rule.reason);
    }
  }

  return command;
}

export function isTextBuffer(buffer: Uint8Array): boolean {
  const sample = buffer.subarray(0, 8_000);
  for (const byte of sample) {
    if (byte === 0) return false;
  }
  return true;
}
