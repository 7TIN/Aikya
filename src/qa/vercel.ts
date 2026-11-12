import { Sandbox } from "@vercel/sandbox";
import { sandboxEnv } from "../preview/sandbox.ts";
import { walkRepo } from "./files.ts";
import { readTextFile } from "./files.ts";
import { safeRelPath } from "./guard.ts";
import type {
  QaCommandResult,
  QaReadOptions,
  QaRunOptions,
  QaSandbox,
} from "./types.ts";

/**
 * Dedicated Vercel Sandbox for QA. It is created from the local working tree,
 * runs with a scrubbed environment, and is deleted when the run ends.
 *
 * The agent loop and model credentials stay on the host; the model only ever
 * sees tool output. The sandbox has no Neon, GitHub, or Vercel management
 * credentials.
 */

const DEFAULT_TIMEOUT_MS = 20 * 60_000;
const DEFAULT_MAX_OUTPUT_CHARS = 20_000;
const MAX_READ_CHARS = 30_000;
const MAX_DIFF_CHARS = 400_000;
const MAX_UPLOAD_BYTES = 25_000_000;
const MAX_FILE_BYTES = 1_000_000;
const UPLOAD_BATCH = 40;

interface VercelCommandResult {
  exitCode: number | null;
  stdout(): Promise<string>;
  stderr(): Promise<string>;
}

/** The subset of the SDK surface QA needs, injectable for tests. */
export interface VercelSandboxClient {
  readonly name: string;
  readonly cwd: string;
  runCommand(params: {
    cmd: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<VercelCommandResult>;
  writeFiles(
    files: Array<{ path: string; content: string | Uint8Array }>,
    opts?: { signal?: AbortSignal },
  ): Promise<void>;
  readonly fs: {
    mkdir(path: string, options?: { recursive?: boolean }): Promise<unknown>;
    readFile(path: string, encoding: "utf8"): Promise<string>;
    exists(path: string): Promise<boolean>;
    rm(path: string, options?: { force?: boolean; recursive?: boolean }): Promise<void>;
  };
  delete(opts?: { deleteOrphanSnapshots?: boolean }): Promise<void>;
}

export interface VercelQaSandboxOptions {
  source: string;
  install?: boolean;
  vcpus?: number;
  region?: string;
  image?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  log?: (line: string) => void;
  signal?: AbortSignal;
  /** Injectable client for tests. */
  client?: VercelSandboxClient;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function tail(text: string, maxChars: number): string {
  return text.length > maxChars ? text.slice(-maxChars) : text;
}

export class VercelQaSandbox implements QaSandbox {
  readonly kind = "vercel" as const;
  readonly name: string;

  private constructor(
    readonly root: string,
    private readonly client: VercelSandboxClient,
    private readonly log: (line: string) => void,
  ) {
    this.name = client.name;
  }

  static async create(options: VercelQaSandboxOptions): Promise<VercelQaSandbox> {
    const log = options.log ?? (() => {});
    const env = sandboxEnv({
      ...options.env,
      CI: "1",
      NO_COLOR: "1",
      AIKYA_QA: "1",
    });

    let client: VercelSandboxClient;
    if (options.client) {
      client = options.client;
    } else {
      try {
        const created = await Sandbox.create({
          timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          networkPolicy: "allow-all",
          env,
          resources: { vcpus: options.vcpus ?? 1 },
          ...(options.region ? { region: options.region as never } : {}),
          ...(options.image
            ? { image: options.image as `vercel/sandbox/${string}` }
            : {}),
        });
        client = created as unknown as VercelSandboxClient;
        log(`[qa] created Vercel sandbox ${created.name}`);
      } catch (error) {
        throw new Error(
          `Vercel QA sandbox could not be created: ${errorMessage(error)}. ` +
            "Run `vercel link` and `vercel env pull`, or use --sandbox local.",
        );
      }
    }

    const root = `${client.cwd.replace(/\/$/, "")}/repo`;
    const sandbox = new VercelQaSandbox(root, client, log);

    try {
      await sandbox.client.fs.mkdir(root, { recursive: true });
      await sandbox.upload(options.source, options.signal);
      await sandbox.prepareGit(env, options.signal);

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
    } catch (error) {
      await sandbox.close();
      throw error;
    }

    return sandbox;
  }

  private async upload(source: string, signal?: AbortSignal): Promise<void> {
    const files = await walkRepo(source);
    let total = 0;
    let batch: Array<{ path: string; content: string | Uint8Array }> = [];

    const flush = async () => {
      if (batch.length === 0) return;
      await this.client.writeFiles(batch, { signal });
      batch = [];
    };

    for (const file of files) {
      if (file.size > MAX_FILE_BYTES) continue;
      const text = await readTextFile(file.abs);
      if (text === null) continue;

      const bytes = Buffer.byteLength(text, "utf8");
      if (total + bytes > MAX_UPLOAD_BYTES) break;
      total += bytes;

      batch.push({ path: `${this.root}/${file.rel}`, content: text });
      if (batch.length >= UPLOAD_BATCH) await flush();
    }

    await flush();
    this.log(`[qa] uploaded ${files.length} candidate files (${total} bytes)`);
  }

  private async prepareGit(
    env: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<void> {
    const init = await this.run("git init -q", { timeoutMs: 60_000, signal });
    if (init.exitCode !== 0) {
      throw new Error(
        `QA sandbox needs git for patch capture: ${init.stderr.trim() || "git init failed"}`,
      );
    }
    await this.client.writeFiles([
      {
        path: `${this.root}/.git/info/exclude`,
        content: "node_modules/\ndist/\nartifacts/\ncoverage/\n.vercel/\n",
      },
    ]);
    await this.run("git add -A", { timeoutMs: 120_000, signal });
    const commit = await this.run(
      "git -c user.name=AikyaQA -c user.email=qa@aikya.local commit -qm baseline",
      { timeoutMs: 120_000, signal },
    );
    if (commit.exitCode !== 0) {
      this.log(`[qa] baseline commit failed: ${commit.stderr.trim()}`);
    }
  }

  async run(command: string, options: QaRunOptions = {}): Promise<QaCommandResult> {
    const startedAt = Date.now();
    const maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;

    try {
      const result = await this.client.runCommand({
        cmd: "/bin/sh",
        args: ["-c", command],
        cwd: this.root,
        timeoutMs: options.timeoutMs ?? 180_000,
        signal: options.signal,
      });
      const [stdout, stderr] = await Promise.all([
        result.stdout(),
        result.stderr(),
      ]);

      return {
        command,
        exitCode: result.exitCode ?? 1,
        stdout: tail(stdout, maxOutputChars),
        stderr: tail(stderr, maxOutputChars),
        timedOut: false,
        cancelled: options.signal?.aborted ?? false,
        durationMs: Math.max(0, Date.now() - startedAt),
      };
    } catch (error) {
      const message = errorMessage(error);
      const timedOut = /timed? ?out|timeout/i.test(message);
      return {
        command,
        exitCode: timedOut ? 124 : 1,
        stdout: "",
        stderr: tail(message, maxOutputChars),
        timedOut,
        cancelled: options.signal?.aborted ?? false,
        durationMs: Math.max(0, Date.now() - startedAt),
      };
    }
  }

  async read(path: string, options: QaReadOptions = {}): Promise<string> {
    const rel = safeRelPath(path);
    if (!rel) throw new Error("path is required");
    const text = await this.client.fs.readFile(`${this.root}/${rel}`, "utf8");
    const maxChars = options.maxChars ?? MAX_READ_CHARS;
    if (text.length <= maxChars) return text;
    return `${text.slice(0, maxChars)}\n… [truncated ${text.length - maxChars} chars]`;
  }

  async write(path: string, content: string): Promise<void> {
    const rel = safeRelPath(path);
    if (!rel) throw new Error("path is required");
    await this.client.writeFiles([{ path: `${this.root}/${rel}`, content }]);
  }

  async remove(path: string): Promise<void> {
    const rel = safeRelPath(path);
    if (!rel) throw new Error("path is required");
    await this.client.fs.rm(`${this.root}/${rel}`, { force: true });
  }

  async list(path = ""): Promise<string[]> {
    const prefix = safeRelPath(path || ".");
    const result = await this.run(
      "git ls-files --cached --others --exclude-standard",
      { timeoutMs: 60_000 },
    );
    if (result.exitCode !== 0) return [];

    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((file) => !prefix || file === prefix || file.startsWith(`${prefix}/`))
      .slice(0, 800);
  }

  async exists(path: string): Promise<boolean> {
    try {
      return await this.client.fs.exists(`${this.root}/${safeRelPath(path)}`);
    } catch {
      return false;
    }
  }

  async diff(): Promise<string> {
    await this.run("git add -A", { timeoutMs: 120_000 });
    const result = await this.run("git diff --cached --binary", {
      timeoutMs: 60_000,
      maxOutputChars: MAX_DIFF_CHARS,
    });
    return result.exitCode === 0 ? result.stdout : "";
  }

  async close(): Promise<void> {
    try {
      await this.client.delete({ deleteOrphanSnapshots: true });
      this.log(`[qa] deleted Vercel sandbox ${this.client.name}`);
    } catch (error) {
      this.log(`[qa] could not delete sandbox ${this.client.name}: ${errorMessage(error)}`);
    }
  }
}
