import { cp, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { resolvePreviewContract, type PreviewContract } from "./contract.ts";

/**
 * Workstream W1: run a repository's resolved contract against a throwaway
 * checkout.
 *
 * This is the **local lab backend**. It is not a security boundary: a scrubbed
 * environment, a per-step timeout, and an output cap reduce accidents, but
 * untrusted fork PRs must wait for the container/Vercel Sandbox backend.
 *
 * The future remote backend keeps the same `SandboxResult` shape and replaces
 * `prepareCheckout` (create a Vercel Sandbox, clone inside it) and `runStep`
 * (execute there), so callers do not change.
 */
export const SANDBOX_STEPS = [
  "install",
  "migrate",
  "seed",
  "build",
  "test",
] as const;

export type SandboxStepName = (typeof SANDBOX_STEPS)[number];

export interface SandboxStepResult {
  name: SandboxStepName;
  command: string;
  status: "ok" | "failed" | "skipped";
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
  /** Combined stdout/stderr, capped to `maxOutputChars` per stream. */
  output: string;
}

export type SandboxBackend = "local" | "vercel";

export interface ReviewerOptions {
  /** Enable the deterministic reviewer explorer. Defaults to false. */
  enabled?: boolean;
  /** HTTP paths to probe on the preview app. Defaults to `/` and `/health`. */
  paths?: string[];
  /** Overall reviewer budget in milliseconds. Defaults to 90 seconds. */
  timeoutMs?: number;
  /** Maximum characters retained per HTTP body/log snippet. */
  maxOutputChars?: number;
}

export type ReviewFindingKind = "http" | "db" | "log" | "app";

export interface ReviewFinding {
  kind: ReviewFindingKind;
  title: string;
  status: "ok" | "failed" | "skipped";
  detail?: string;
  /** Capped evidence snippet (never the DATABASE_URL). */
  evidence?: string;
}

export interface ReviewerResult {
  ran: boolean;
  /** Advisory only: a failed review never changes the deterministic preview status. */
  status: "ok" | "failed" | "skipped";
  reason?: string;
  /** Public app URL while the sandbox lives; null after teardown. */
  appUrl: string | null;
  appPort: number | null;
  findings: ReviewFinding[];
  durationMs: number;
  budget: { timeoutMs: number; maxOutputChars: number };
}

export interface SandboxOptions {
  /** Local directory or git URL. */
  source: string;
  /** Execution backend. Defaults to `local`. */
  backend?: SandboxBackend;
  /** Git ref (SHA, branch, or `refs/pull/<n>/merge`) checked out before resolving. */
  ref?: string;
  /**
   * Pre-resolved contract. Normally omitted: the contract is resolved from the
   * checkout so it reflects the PR's own manifest. Tests may inject one.
   */
  contract?: PreviewContract;
  /** Steps to run, in order. Defaults to install → migrate → seed → build → test. */
  steps?: readonly SandboxStepName[];
  /** Per-step timeout in milliseconds. Defaults to 10 minutes. */
  stepTimeoutMs?: number;
  /** Maximum characters retained per stream. Defaults to 20,000. */
  maxOutputChars?: number;
  /** Explicit environment for the run. Everything else is scrubbed. */
  env?: Record<string, string>;
  /** Keep the checkout for inspection instead of deleting it. Local backend only. */
  keepDir?: boolean;
  /** Parent directory for the scratch checkout. Defaults to the OS temp dir. */
  workRoot?: string;
  /** Cooperative cancellation; kills the running step's process tree. */
  signal?: AbortSignal;
  /**
   * Advisory reviewer explorer. Opt-in; only honored by the Vercel backend.
   * The reviewer never changes the deterministic pass/fail status.
   */
  review?: ReviewerOptions;
  /**
   * Vercel backend settings. The source must be a public git URL, or a local
   * git repository whose origin is a public HTTPS URL. Local directories and
   * private/SSH remotes fail closed because Vercel cannot clone them.
   */
  vercel?: {
    /** vCPU count. Default: Vercel's default (2). */
    vcpus?: number;
    /** Vercel region, e.g. `iad1`. Default: project default or `iad1`. */
    region?: string;
    /** Image reference. Default: `vercel/sandbox/universal:latest`. */
    image?: string;
    /** Firewall policy. Default: allow-all (required for package registries). */
    networkPolicy?: "allow-all" | "deny-all";
    /** Sandbox TTL. Default: 30 minutes. */
    sandboxTimeoutMs?: number;
    /** Optional fixed sandbox name. Random names are safer. */
    name?: string;
  };
  log?: (line: string) => void;
}

export interface SandboxResult {
  ok: boolean;
  source: string;
  ref: string | null;
  /** Backend that executed the run. */
  backend: SandboxBackend;
  /** Checkout path only when `keepDir` is set; otherwise null after teardown. */
  dir: string | null;
  contract: PreviewContract | null;
  steps: SandboxStepResult[];
  review?: ReviewerResult;
  error: string | null;
  durationMs: number;
}

const DEFAULT_STEP_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_MAX_OUTPUT_CHARS = 20_000;

/**
 * Environment variables a child process needs to find binaries and a home
 * directory. Everything else — DATABASE_URL, NEON_API_KEY, GITHUB_TOKEN,
 * cloud credentials — is deliberately absent.
 */
const PASS_THROUGH_ENV = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SystemRoot",
  "SYSTEMROOT",
  "ComSpec",
  "COMSPEC",
  "PATHEXT",
  "WINDIR",
  "APPDATA",
  "LOCALAPPDATA",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "LANG",
  "LC_ALL",
  "TERM",
] as const;

export function sandboxEnv(
  extra: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {
    CI: "1",
    AIKYA_SANDBOX: "1",
  };

  for (const key of PASS_THROUGH_ENV) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }

  return { ...env, ...extra };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isGitUrl(source: string): boolean {
  return /^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/.test(source);
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function runGit(args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], {
    env: sandboxEnv(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = new Response(
    proc.stdout as unknown as ReadableStream<Uint8Array>,
  ).text();
  const stderr = new Response(
    proc.stderr as unknown as ReadableStream<Uint8Array>,
  ).text();
  const exitCode = await proc.exited;
  const [out, err] = await Promise.all([stdout, stderr]);

  if (exitCode !== 0) {
    const tail = (err || out)
      .trim()
      .split(/\r?\n/)
      .slice(-3)
      .join(" ");
    throw new Error(
      `git ${args.join(" ")} failed (exit ${exitCode})${tail ? `: ${tail}` : ""}`,
    );
  }
}

/**
 * Exported for the Vercel backend, which reads the contract before handing
 * the source to the remote sandbox. Never run repository code here.
 */
export async function prepareCheckout(options: SandboxOptions): Promise<{
  parent: string;
  dir: string;
}> {
  const source = resolve(options.source);
  const local = await isDirectory(source);

  if (!local && !isGitUrl(options.source)) {
    throw new Error(
      `Sandbox source "${options.source}" is neither a local directory nor a git URL.`,
    );
  }

  const parent = await mkdtemp(
    join(options.workRoot ?? tmpdir(), "aikya-sandbox-"),
  );
  const dir = join(parent, "repo");

  try {
    if (local) {
      const hasGit = await isDirectory(join(source, ".git"));
      if (hasGit) {
        // Clone instead of copy so the checkout has a writable origin and the
        // requested ref can be fetched without touching the source tree.
        await runGit(["clone", "--quiet", "--no-hardlinks", source, dir]);
      } else {
        await cp(source, dir, { recursive: true, force: true });
      }
    } else {
      await runGit(["clone", "--quiet", options.source, dir]);
    }

    if (options.ref) {
      if (!(await isDirectory(join(dir, ".git")))) {
        throw new Error(
          `Cannot check out "${options.ref}": the source is not a git repository.`,
        );
      }

      // `refs/pull/<n>/merge` is not fetched by a normal clone.
      if (options.ref.startsWith("refs/pull/")) {
        await runGit(["-C", dir, "fetch", "--quiet", "origin", options.ref]);
        await runGit(["-C", dir, "checkout", "--quiet", "--force", "FETCH_HEAD"]);
      } else {
        await runGit(["-C", dir, "checkout", "--quiet", "--force", options.ref]);
      }
    }

    return { parent, dir };
  } catch (error) {
    await rm(parent, { recursive: true, force: true });
    throw error;
  }
}

function shellCommand(scriptPath: string): string[] {
  if (process.platform === "win32") {
    // `cwd` is the repo and the script sits one level up. A relative path has
    // no spaces, which avoids cmd.exe/Bun argv quoting problems on Windows.
    return [
      process.env.ComSpec ?? "cmd.exe",
      "/d",
      "/s",
      "/c",
      join("..", basename(scriptPath)),
    ];
  }
  return ["/bin/sh", scriptPath];
}

/**
 * Write the command to a script instead of passing it through a shell string.
 * Windows quoting through `cmd /c` is fragile, and a script also preserves
 * multi-line commands exactly as the contract wrote them.
 */
async function writeStepScript(
  scriptDir: string,
  name: SandboxStepName,
  command: string,
): Promise<string> {
  const windows = process.platform === "win32";
  const path = join(scriptDir, `step-${name}.${windows ? "cmd" : "sh"}`);
  const body = windows
    ? `@echo off\r\n${command}\r\nexit /b %errorlevel%\r\n`
    : `set -e\n${command}\n`;

  await writeFile(path, body, "utf8");
  return path;
}

/** Kill the step and anything it spawned. Windows needs `taskkill /T`. */
function killTree(pid: number | undefined): void {
  if (!pid) return;

  if (process.platform === "win32") {
    Bun.spawnSync(
      ["taskkill", "/pid", String(pid), "/T", "/F"],
      { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
    );
    return;
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The process already exited.
  }
}

async function readLimited(
  stream: ReadableStream<Uint8Array> | undefined,
  maxChars: number,
): Promise<string> {
  if (!stream) return "";

  const decoder = new TextDecoder();
  let text = "";

  for await (const chunk of stream) {
    text += decoder.decode(chunk, { stream: true });
    if (text.length > maxChars) text = text.slice(-maxChars);
  }

  text += decoder.decode();
  return text.length > maxChars ? text.slice(-maxChars) : text;
}

async function waitForExit(
  proc: ReturnType<typeof Bun.spawn>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<{ exitCode: number; timedOut: boolean; cancelled: boolean }> {
  let timedOut = false;
  let cancelled = false;

  const onAbort = () => {
    cancelled = true;
    killTree(proc.pid);
  };

  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });

  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          killTree(proc.pid);
        }, timeoutMs)
      : undefined;

  const exitCode = await proc.exited;

  if (timer) clearTimeout(timer);
  signal?.removeEventListener("abort", onAbort);

  return { exitCode, timedOut, cancelled };
}

interface RunStepInput {
  name: SandboxStepName;
  command: string;
  cwd: string;
  /** Scratch parent holding generated step scripts (outside the checkout). */
  scriptDir: string;
  env: Record<string, string>;
  timeoutMs: number;
  maxOutputChars: number;
  signal?: AbortSignal;
}

export function skippedStep(
  name: SandboxStepName,
  reason: string,
  cancelled = false,
): SandboxStepResult {
  return {
    name,
    command: "",
    status: "skipped",
    exitCode: null,
    durationMs: 0,
    timedOut: false,
    cancelled,
    output: reason,
  };
}

async function runStep(input: RunStepInput): Promise<SandboxStepResult> {
  const startedAt = Date.now();

  if (input.signal?.aborted) {
    return {
      ...skippedStep(input.name, "cancelled before start", true),
      command: input.command,
    };
  }

  let scriptPath: string;
  try {
    scriptPath = await writeStepScript(
      input.scriptDir,
      input.name,
      input.command,
    );
  } catch (error) {
    return {
      name: input.name,
      command: input.command,
      status: "failed",
      exitCode: null,
      durationMs: Date.now() - startedAt,
      timedOut: false,
      cancelled: false,
      output: `failed to write step script: ${errorMessage(error)}`,
    };
  }

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(shellCommand(scriptPath), {
      cwd: input.cwd,
      env: input.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    return {
      name: input.name,
      command: input.command,
      status: "failed",
      exitCode: null,
      durationMs: Date.now() - startedAt,
      timedOut: false,
      cancelled: false,
      output: `failed to start: ${errorMessage(error)}`,
    };
  }

  // Start draining both pipes before waiting: a full pipe would deadlock a
  // chatty test suite.
  const readers = Promise.all([
    readLimited(
      proc.stdout as unknown as ReadableStream<Uint8Array> | undefined,
      input.maxOutputChars,
    ),
    readLimited(
      proc.stderr as unknown as ReadableStream<Uint8Array> | undefined,
      input.maxOutputChars,
    ),
  ]);

  const { exitCode, timedOut, cancelled } = await waitForExit(
    proc,
    input.timeoutMs,
    input.signal,
  );
  const [stdout, stderr] = await readers;

  const output = [stdout.trimEnd(), stderr.trimEnd()]
    .filter((part) => part.length > 0)
    .join("\n");

  return {
    name: input.name,
    command: input.command,
    status: exitCode === 0 && !timedOut && !cancelled ? "ok" : "failed",
    exitCode,
    durationMs: Date.now() - startedAt,
    timedOut,
    cancelled,
    output,
  };
}

/**
 * Create a throwaway checkout, resolve the PR's own contract, and run the
 * configured steps with a scrubbed environment and hard limits.
 *
 * The checkout is removed in `finally` unless `keepDir` is set.
 */
export async function runSandbox(
  options: SandboxOptions,
): Promise<SandboxResult> {
  const backend = options.backend ?? "local";
  if (backend === "vercel") {
    // Loaded lazily so ordinary local tests don't require the SDK credentials.
    const { runVercelSandbox } = await import("./vercel.ts");
    return runVercelSandbox(options);
  }

  const startedAt = Date.now();
  const ref = options.ref?.trim() || null;
  const stepTimeoutMs = options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  const maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  const log = options.log ?? (() => {});

  let parent: string | null = null;
  let dir: string | null = null;
  let contract = options.contract ?? null;

  const result: SandboxResult = {
    ok: false,
    source: options.source,
    ref,
    backend,
    dir: null,
    contract,
    steps: [],
    review: options.review?.enabled
      ? {
          ran: false,
          status: "skipped",
          reason: "reviewer requires the Vercel backend",
          appUrl: null,
          appPort: null,
          findings: [],
          durationMs: 0,
          budget: {
            timeoutMs: options.review.timeoutMs ?? 90_000,
            maxOutputChars:
              options.review.maxOutputChars ?? maxOutputChars,
          },
        }
      : undefined,
    error: null,
    durationMs: 0,
  };

  try {
    const prepared = await prepareCheckout(options);
    parent = prepared.parent;
    dir = prepared.dir;
    const scriptDir = prepared.parent;
    log(`[sandbox] checkout ${dir}${ref ? ` @ ${ref}` : ""}`);

    contract = contract ?? (await resolvePreviewContract(dir));
    result.contract = contract;

    const requested = options.steps ?? SANDBOX_STEPS;
    let failed = false;
    let cancelled = false;

    for (const name of requested) {
      if (cancelled || options.signal?.aborted) {
        cancelled = true;
        result.steps.push(skippedStep(name, "cancelled", true));
        continue;
      }
      if (failed) {
        result.steps.push(skippedStep(name, "skipped: previous step failed"));
        continue;
      }

      const command = contract[name];
      if (!command) {
        result.steps.push(skippedStep(name, "not configured by the contract"));
        continue;
      }

      log(`[sandbox] ${name}: ${command}`);
      const step = await runStep({
        name,
        command,
        cwd: dir,
        scriptDir,
        env: sandboxEnv(options.env),
        timeoutMs: stepTimeoutMs,
        maxOutputChars,
        signal: options.signal,
      });
      result.steps.push(step);

      if (step.status === "failed") failed = true;
      if (step.cancelled) cancelled = true;
    }

    const failedStep = result.steps.find((step) => step.status === "failed");
    if (failedStep) {
      result.error = `Step "${failedStep.name}" failed${
        failedStep.timedOut
          ? " (timed out)"
          : failedStep.cancelled
            ? " (cancelled)"
            : failedStep.exitCode !== null
              ? ` with exit code ${failedStep.exitCode}`
              : ""
      }.`;
    } else if (cancelled) {
      result.error = "Sandbox run was cancelled.";
    }

    result.ok = result.error === null;
  } catch (error) {
    result.error = errorMessage(error);
    result.ok = false;
  } finally {
    if (parent && !options.keepDir) {
      await rm(parent, { recursive: true, force: true });
    }
    result.durationMs = Date.now() - startedAt;
    result.dir = options.keepDir ? dir : null;
  }

  return result;
}
