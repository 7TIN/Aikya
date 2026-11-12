import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { isTextBuffer } from "./guard.ts";

/**
 * File walking and filtering used by both sandbox backends. A QA checkout never
 * includes dependencies, build output, git metadata, or dotenv files.
 */

const SKIPPED_SEGMENTS = new Set([
  ".agents",
  ".claude",
  ".git",
  ".next",
  ".vercel",
  "artifacts",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "tmp",
]);

const SKIPPED_FILE =
  /^(\.env(\..*)?|skills-lock\.json|repos\.local\.json|bun\.lockb|\.DS_Store)$/i;

export function isSkipped(rel: string): boolean {
  const parts = rel.split(/[\\/]/).filter(Boolean);
  if (parts.some((part) => SKIPPED_SEGMENTS.has(part.toLowerCase()))) {
    return true;
  }
  const base = parts[parts.length - 1] ?? "";
  return SKIPPED_FILE.test(base);
}

export interface RepoFile {
  rel: string;
  abs: string;
  size: number;
}

/** List readable text files under `root`, skipping the QA exclusions. */
export async function walkRepo(root: string): Promise<RepoFile[]> {
  const files: RepoFile[] = [];

  async function visit(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const abs = join(dir, entry.name);
      const rel = relative(root, abs).split(sep).join("/");
      if (isSkipped(rel)) continue;

      if (entry.isDirectory()) {
        await visit(abs);
        continue;
      }
      if (!entry.isFile()) continue;

      try {
        const info = await stat(abs);
        files.push({ rel, abs, size: info.size });
      } catch {
        // File vanished between readdir and stat.
      }
    }
  }

  await visit(root);
  return files.sort((left, right) => left.rel.localeCompare(right.rel));
}

/** Read a repo file as UTF-8, or null when it is binary. */
export async function readTextFile(abs: string): Promise<string | null> {
  const buffer = await readFile(abs);
  if (!isTextBuffer(buffer)) return null;
  return buffer.toString("utf8");
}
