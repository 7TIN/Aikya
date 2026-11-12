import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { sandboxEnv } from "../preview/sandbox.ts";
import { runShell } from "./exec.ts";
import { isSkipped, walkRepo } from "./files.ts";
import { resolveInside, safeRelPath } from "./guard.ts";
import type {
  QaCommandResult,
  QaReadOptions,
  QaRunOptions,
  QaSandbox,
} from "./types.ts";

/**
 * A disposable copy of the repository under the OS temp directory.
 *
 * This is fast and works with unpushed changes, but it is **not** a security
 * boundary: the host user can still reach the filesystem. Use the Vercel
 * backend when the code under test is untrusted.
 */

const DEFAULT_MAX_READ_CHARS = 30_000;
const MAX_DIFF_CHARS = 400_000;

export interface LocalQaSandboxOptions {
  source: string;
  /** Run `bun install` before returning. Defaults to true. */
  install?: boolean;
  env?: Record<string, string>;
  log?: (line: string) => void;
  signal?: AbortSignal;
}

export class LocalQaSandbox implements QaSandbox {
  readonly kind = "local" as const;
  readonly name: string;

  private constructor(
    readonly root: string,
    private readonly workspace: string,
    private readonly env: Record<string, string>,
    private readonly log: (line: string) => void,
  ) {
    this.name = `local:${workspace.split(/[\\/]/).pop() ?? "workspace"}`;
  }

  static async create(options: LocalQaSandboxOptions): Promise<LocalQaSandbox> {
    const log = options.log ?? (() => {});
    const workspace = await mkdtemp(join(tmpdir(), "aikya-qa-"));
    const root = join(workspace, "repo");
    const source = resolve(options.source);

    log(`[qa] copying ${source} to ${root}`);
    try {
      await cp(source, root, {
        recursive: true,
        force: true,
        filter: (src) => {
          const rel = src.slice(source.length).replace(/^[\\/]+/, "");
          if (rel === "") return true;
          if (isSkipped(rel)) return false;
          try {
            // A QA checkout is a plain copy: symlinks can escape the workspace
            // and some skill packs link into excluded directories.
            return !lstatSync(src).isSymbolicLink();
          } catch {
            return false;
          }
        },
      });
    } catch (error) {
      await rm(workspace, { recursive: true, force: true });
      throw error;
    }

    const env = sandboxEnv({
      ...options.env,
      CI: "1",
      NO_COLOR: "1",
      AIKYA_QA: "1",
    });
    const sandbox = new LocalQaSandbox(root, workspace, env, log);

    const git = await runShell("git init -q", {
      cwd: root,
      env,
      timeoutMs: 60_000,
      signal: options.signal,
    });
    if (git.exitCode !== 0) {
      await sandbox.close();
      throw new Error(
        `QA workspace needs git for patch capture: ${git.stderr.trim() || "git init failed"}`,
      );
    }

    await writeFile(
      join(root, ".git", "info", "exclude"),
      "node_modules/\ndist/\nartifacts/\ncoverage/\n.vercel/\n",
      "utf8",
    );

    await runShell("git add -A", {
      cwd: root,
      env,
      timeoutMs: 120_000,
      signal: options.signal,
    });
    const commit = await runShell(
      "git -c user.name=AikyaQA -c user.email=qa@aikya.local commit -qm baseline",
      { cwd: root, env, timeoutMs: 120_000, signal: options.signal },
    );
    if (commit.exitCode !== 0) {
      log(`[qa] baseline commit failed: ${commit.stderr.trim()}`);
    }

    if (options.install !== false) {
      const hasLock = await sandbox.exists("bun.lock");
      const command = hasLock ? "bun install --frozen-lockfile" : "bun install";
      log(`[qa] ${command}`);
      const install = await sandbox.run(command, {
        timeoutMs: 300_000,
        signal: options.signal,
      });
      if (install.exitCode !== 0) {
        log(
          `[qa] install failed (exit ${install.exitCode}); checks will report the failure`,
        );
      }
    }

    return sandbox;
  }

  async run(command: string, options: QaRunOptions = {}): Promise<QaCommandResult> {
    return runShell(command, {
      cwd: this.root,
      env: this.env,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });
  }

  async read(path: string, options: QaReadOptions = {}): Promise<string> {
    const rel = safeRelPath(path);
    if (!rel) throw new Error("path is required");
    const abs = resolveInside(this.root, rel);
    const buffer = await readFile(abs);
    if (buffer.includes(0)) throw new Error(`${rel} is a binary file`);

    const maxChars = options.maxChars ?? DEFAULT_MAX_READ_CHARS;
    const text = buffer.toString("utf8");
    if (text.length <= maxChars) return text;
    return `${text.slice(0, maxChars)}\n… [truncated ${text.length - maxChars} chars]`;
  }

  async write(path: string, content: string): Promise<void> {
    const rel = safeRelPath(path);
    if (!rel) throw new Error("path is required");
    const abs = resolveInside(this.root, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
  }

  async remove(path: string): Promise<void> {
    const rel = safeRelPath(path);
    if (!rel) throw new Error("path is required");
    await rm(resolveInside(this.root, rel), { force: true });
  }

  async list(path = ""): Promise<string[]> {
    const prefix = safeRelPath(path || ".");
    const tracked = await runShell(
      "git ls-files --cached --others --exclude-standard",
      { cwd: this.root, env: this.env, timeoutMs: 60_000 },
    );

    let files: string[];
    if (tracked.exitCode === 0) {
      files = tracked.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    } else {
      files = (await walkRepo(this.root)).map((file) => file.rel);
    }

    return files
      .filter((file) => !isSkipped(file))
      .filter((file) => !prefix || file === prefix || file.startsWith(`${prefix}/`))
      .slice(0, 800);
  }

  async exists(path: string): Promise<boolean> {
    try {
      await stat(resolveInside(this.root, safeRelPath(path)));
      return true;
    } catch {
      return false;
    }
  }

  async diff(): Promise<string> {
    await runShell("git add -A", {
      cwd: this.root,
      env: this.env,
      timeoutMs: 120_000,
    });
    const result = await runShell("git diff --cached --binary", {
      cwd: this.root,
      env: this.env,
      timeoutMs: 60_000,
    });
    const patch = result.exitCode === 0 ? result.stdout : "";
    return patch.length > MAX_DIFF_CHARS
      ? `${patch.slice(0, MAX_DIFF_CHARS)}\n… [patch truncated]`
      : patch;
  }

  async close(): Promise<void> {
    await rm(this.workspace, { recursive: true, force: true });
  }
}
