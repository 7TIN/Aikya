import { rm, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { Sandbox } from "@vercel/sandbox";
import { resolvePreviewContract, type PreviewContract } from "./contract.ts";
import {
  prepareCheckout,
  sandboxEnv,
  SANDBOX_STEPS,
  skippedStep,
  type SandboxBackend,
  type SandboxOptions,
  type SandboxResult,
  type SandboxStepResult,
} from "./sandbox.ts";

/**
 * Vercel Sandbox backend for the repository preview runner.
 *
 * The backend is opt-in (`--backend vercel`) and **does not fall back to a
 * local sandbox** when it cannot clone or create the remote environment. It
 * also does not copy local credentials into the sandbox; the only values it
 * passes are explicit `options.env` (for example, a branch-scoped
 * `DATABASE_URL`).
 */

export interface SandboxCommandResult {
  exitCode: number;
  durationMs?: number;
  stdout(): Promise<string>;
  stderr(): Promise<string>;
}

export interface SandboxClient {
  name: string;
  runCommand(params: {
    cmd: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<SandboxCommandResult>;
  delete(options?: { deleteOrphanSnapshots?: boolean }): Promise<void>;
}

export type SandboxFactory = (
  params: Record<string, unknown>,
) => Promise<SandboxClient>;

export interface VercelSandboxDependencies {
  /** Inject the SDK (tests use a fake). */
  createSandbox?: SandboxFactory;
  /** Inject contract resolution (tests avoid cloning from a remote). */
  resolveContract?: (source: string, ref: string | null) => Promise<PreviewContract>;
}

const DEFAULT_SANDBOX_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_STEP_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_MAX_OUTPUT_CHARS = 20_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isGitUrl(source: string): boolean {
  return /^https?:\/\/.+/i.test(source);
}

function pathname(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/** Name of the subdirectory Vercel creates when cloning a git source. */
export function repoDirFromSource(source: string): string {
  const segments = pathname(source)
    .split("/")
    .filter(Boolean)
    .map(decodeURIComponent);
  const last = segments.at(-1)?.replace(/\.git$/i, "") ?? "repo";
  return last.replace(/[;&`$(){}<>|]/g, "-") || "repo";
}

/** Return the path if absolute, else resolve it against the process cwd. */
function absoluteSource(source: string): string {
  return isAbsolute(source) ? source : resolve(source);
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function gitRemoteOf(dir: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const proc = Bun.spawn(
      ["git", "-C", dir, "remote", "get-url", "origin"],
      {
        env: sandboxEnv(),
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    void (async () => {
      const stdout = await new Response(
        proc.stdout as unknown as ReadableStream<Uint8Array>,
      ).text();
      const stderr = await new Response(
        proc.stderr as unknown as ReadableStream<Uint8Array>,
      ).text();
      const exitCode = await proc.exited;
      if (exitCode === 0) {
        resolvePromise(stdout.trim());
      } else {
        rejectPromise(
          new Error(stderr.trim() || `git remote get-url origin failed (exit ${exitCode})`),
        );
      }
    })();
  });
}

function assertHttpsSource(url: string, source: string): void {
  if (!/^https:\/\/.+/i.test(url)) {
    throw new Error(
      `Vercel Sandbox cannot clone "${source}". The source must be a public HTTPS git URL; ` +
        `got "${url}". Use a public HTTPS origin (for example https://github.com/owner/repo.git).`,
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid Vercel source URL: ${url}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(
      "Refusing to pass credentials embedded in a git URL to Vercel. " +
        "Use a public HTTPS repository or publish a tokenized source through your own tunnel.",
    );
  }
}

/**
 * Normalize a source for the remote sandbox:
 * public git URL, or a local git repo with a public HTTPS origin.
 */
async function resolveVercelSource(
  source: string,
): Promise<{ url: string; directory: string }> {
  if (isGitUrl(source)) {
    assertHttpsSource(source, source);
    return { url: source, directory: repoDirFromSource(source) };
  }

  const dir = absoluteSource(source);
  if (!(await directoryExists(dir))) {
    throw new Error(
      `Vercel backend source "${source}" is neither a public HTTPS git URL nor a local directory.`,
    );
  }
  if (!(await directoryExists(`${dir}/.git`))) {
    throw new Error(
      `Vercel backend cannot copy local directory "${dir}" into the remote sandbox. ` +
        "Commit it to a git remote and use the repository's HTTPS URL.",
    );
  }

  const remote = await gitRemoteOf(dir).catch((error: unknown) => {
    if (error instanceof Error && error.message.includes("origin")) {
      throw new Error(
        `Vercel backend cannot copy local repository "${dir}" because it has no "origin" remote. ` +
          "Add a public HTTPS origin, or pass the public repository URL directly.",
      );
    }
    throw error;
  });

  assertHttpsSource(remote, dir);
  return { url: remote, directory: repoDirFromSource(remote) };
}

function capOutput(text: string, maxChars: number): string {
  return text.length > maxChars ? text.slice(-maxChars) : text;
}

async function doubleCapOutput(
  command: SandboxCommandResult,
  maxChars: number,
): Promise<string> {
  const [stdout, stderr] = await Promise.all([
    command.stdout(),
    command.stderr(),
  ]);
  return [capOutput(stdout.trimEnd(), maxChars), capOutput(stderr.trimEnd(), maxChars)]
    .filter((part) => part.length > 0)
    .join("\n");
}

function defaultSandboxFactory(params: Record<string, unknown>): Promise<SandboxClient> {
  return Sandbox.create(
    params as Parameters<typeof Sandbox.create>[0],
  ) as unknown as Promise<SandboxClient>;
}

function defaultStepEnv(options: SandboxOptions): Record<string, string> {
  return {
    CI: "1",
    AIKYA_SANDBOX: "1",
    ...(options.env ?? {}),
  };
}

/**
 * Run the contract in a Vercel Sandbox microVM.
 *
 * The contract is resolved from a throwaway clone first (no repository code is
 * executed). The remote sandbox receives only its clone URL and explicit
 * step environment; Aikya's Neon and GitHub credentials are never passed.
 */
export async function runVercelSandbox(
  options: SandboxOptions,
  dependencies: VercelSandboxDependencies = {},
): Promise<SandboxResult> {
  const startedAt = Date.now();
  const ref = options.ref?.trim() || null;
  const stepTimeoutMs = options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  const maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  const sandboxTimeoutMs = options.vercel?.sandboxTimeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS;
  const log = options.log ?? (() => {});

  let contract = options.contract ?? null;
  let remote: { url: string; directory: string } | null = null;

  const baseResult = (error: string | null): SandboxResult => ({
    ok: false,
    source: options.source,
    ref,
    backend: "vercel" satisfies SandboxBackend,
    dir: null,
    contract,
    steps: [],
    error,
    durationMs: Date.now() - startedAt,
  });

  try {
    if (options.signal?.aborted) {
      return { ...baseResult("Sandbox run was cancelled before it started."), backend: "vercel" };
    }

    remote = await resolveVercelSource(options.source);
    log(`[sandbox] vercel source ${remote.url}${ref ? ` @ ${ref}` : ""}`);

    if (!contract) {
      const prepared = await prepareCheckout({ source: options.source, ref: ref ?? undefined });
      try {
        contract = await resolvePreviewContract(prepared.dir);
      } finally {
        await rm(prepared.parent, { recursive: true, force: true });
      }
    }

    return await runVercelCommands({
      options,
      remote,
      contract,
      stepTimeoutMs,
      sandboxTimeoutMs,
      maxOutputChars,
      startedAt,
      dependencies,
    });
  } catch (error) {
    return {
      ...baseResult(errorMessage(error)),
      durationMs: Date.now() - startedAt,
    };
  }
}

interface RunCommandsInput {
  options: SandboxOptions;
  remote: { url: string; directory: string };
  contract: PreviewContract | null;
  stepTimeoutMs: number;
  sandboxTimeoutMs: number;
  maxOutputChars: number;
  startedAt: number;
  dependencies: VercelSandboxDependencies;
}

async function runVercelCommands(
  input: RunCommandsInput,
): Promise<SandboxResult> {
  const {
    options,
    remote,
    contract,
    stepTimeoutMs,
    sandboxTimeoutMs,
    maxOutputChars,
    startedAt,
    dependencies,
  } = input;
  const log = options.log ?? (() => {});
  const ref = options.ref?.trim() || null;
  const vcpus = options.vercel?.vcpus;

  const params: Record<string, unknown> = {
    source: ref
      ? { type: "git", url: remote.url, revision: ref }
      : { type: "git", url: remote.url },
    image: options.vercel?.image,
    resources: vcpus === undefined ? undefined : { vcpus },
    networkPolicy: options.vercel?.networkPolicy ?? "allow-all",
    timeout: sandboxTimeoutMs,
    persistent: false,
    snapshotExpiration: 0,
    tags: { aikya: "preview" },
    ...(options.vercel?.region ? { region: options.vercel.region } : {}),
    ...(options.vercel?.name ? { name: options.vercel.name } : {}),
  };

  const createSandbox = dependencies.createSandbox ?? defaultSandboxFactory;
  let sandbox: SandboxClient | null = null;
  const result: SandboxResult = {
    ok: false,
    source: options.source,
    ref,
    backend: "vercel",
    dir: null,
    contract,
    steps: [],
    error: null,
    durationMs: 0,
  };

  try {
    sandbox = await createSandbox(params);
    log(`[sandbox] created ${sandbox.name}`);

    const stepNames = [...(options.steps ?? SANDBOX_STEPS)];
    const env = defaultStepEnv(options);
    let failed = false;
    let cancelled = false;

    for (const name of stepNames) {
      if (options.signal?.aborted || cancelled) {
        cancelled = true;
        result.steps.push(skippedStep(name, "cancelled", true));
        continue;
      }
      if (failed) {
        result.steps.push(skippedStep(name, "skipped: previous step failed"));
        continue;
      }

      const command = contract?.[name];
      if (!command) {
        result.steps.push(skippedStep(name, "not configured by the contract"));
        continue;
      }

      log(`[sandbox] ${name}: ${command}`);
      const started = Date.now();
      let step: SandboxStepResult;
      try {
        const commandResult = await sandbox.runCommand({
          cmd: "sh",
          args: ["-c", command],
          cwd: remote.directory,
          env,
          timeoutMs: stepTimeoutMs,
          signal: options.signal,
        });
        const output = await doubleCapOutput(commandResult, maxOutputChars);
        const durationMs = commandResult.durationMs ?? Date.now() - started;
        const timedOut =
          stepTimeoutMs > 0 &&
          durationMs >= stepTimeoutMs - 50 &&
          commandResult.exitCode !== 0;
        const cancelledNow = options.signal?.aborted === true;
        step = {
          name,
          command,
          status:
            commandResult.exitCode === 0 && !timedOut && !cancelledNow
              ? "ok"
              : "failed",
          exitCode: commandResult.exitCode,
          durationMs,
          timedOut,
          cancelled: cancelledNow,
          output,
        };
        if (cancelledNow) cancelled = true;
      } catch (error) {
        const cancelledNow = options.signal?.aborted === true;
        step = {
          name,
          command,
          status: "failed",
          exitCode: null,
          durationMs: Date.now() - started,
          timedOut: false,
          cancelled: cancelledNow,
          output: cancelledNow
            ? "cancelled"
            : `failed to run command: ${errorMessage(error)}`,
        };
        if (cancelledNow) cancelled = true;
      }

      result.steps.push(step);
      if (step.status === "failed") failed = true;
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
    result.durationMs = Date.now() - startedAt;
    return result;
  } catch (error) {
    return {
      ...result,
      error: `Vercel sandbox could not be created: ${errorMessage(error)}`,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    if (sandbox) {
      const name = sandbox.name;
      try {
        await sandbox.delete({ deleteOrphanSnapshots: true });
        log(`[sandbox] deleted ${name}`);
      } catch {
        // The sandbox auto-stops after its timeout; report the path locally.
        log(`[sandbox] could not delete ${name} (it will stop at its timeout)`);
      }
    }
  }
}
