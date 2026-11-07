import { rm, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { Sandbox } from "@vercel/sandbox";
import { resolvePreviewContract, type PreviewContract } from "./contract.ts";
import {
  prepareCheckout,
  sandboxEnv,
  SANDBOX_STEPS,
  skippedStep,
  type ReviewFinding,
  type ReviewerOptions,
  type ReviewerResult,
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
  /** Public URL for an exposed port (SDK `sandbox.domain(port)`). */
  domain?: (port: number) => string;
}

export type SandboxFactory = (
  params: Record<string, unknown>,
) => Promise<SandboxClient>;

export interface VercelSandboxDependencies {
  /** Inject the SDK (tests use a fake). */
  createSandbox?: SandboxFactory;
  /** Inject contract resolution (tests avoid cloning from a remote). */
  resolveContract?: (source: string, ref: string | null) => Promise<PreviewContract>;
  /** Inject HTTP probing (tests avoid the network). */
  reviewFetch?: typeof fetch;
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

const DEFAULT_REVIEW_TIMEOUT_MS = 90_000;
const DEFAULT_REVIEW_PATHS = ["/", "/health"] as const;
const REVIEW_APP_LOG = "/tmp/aikya-review-app.log";
const REVIEW_DB_SCRIPT = "/tmp/aikya-review-db.ts";

function reviewBudget(options: SandboxOptions): { timeoutMs: number; maxOutputChars: number } {
  return {
    timeoutMs: options.review?.timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS,
    maxOutputChars: options.review?.maxOutputChars ?? 5_000,
  };
}

function skippedReview(
  reason: string,
  budget: { timeoutMs: number; maxOutputChars: number },
): ReviewerResult {
  return {
    ran: false,
    status: "skipped",
    reason,
    appUrl: null,
    appPort: null,
    findings: [],
    durationMs: 0,
    budget,
  };
}

function normalizePaths(paths: string[] | undefined): string[] {
  const raw = paths?.length ? paths : [...DEFAULT_REVIEW_PATHS];
  const unique: string[] = [];
  for (const path of raw) {
    const normalized = path.startsWith("/") ? path : `/${path}`;
    if (!unique.includes(normalized)) unique.push(normalized);
  }
  return unique;
}

async function runReviewCommand(
  sandbox: SandboxClient,
  command: string,
  env: Record<string, string>,
  cwd: string,
  timeoutMs: number,
  maxOutputChars: number,
  signal?: AbortSignal,
): Promise<{ exitCode: number; output: string }> {
  const result = await sandbox.runCommand({
    cmd: "sh",
    args: ["-c", command],
    cwd,
    env,
    timeoutMs,
    signal,
  });
  return {
    exitCode: result.exitCode,
    output: await doubleCapOutput(result, maxOutputChars),
  };
}

async function waitForApp(
  fetchImpl: typeof fetch,
  baseUrl: string,
  deadline: number,
  signal?: AbortSignal,
): Promise<boolean> {
  while (Date.now() < deadline && !signal?.aborted) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4_000);
      try {
        await fetchImpl(baseUrl, { signal: controller.signal });
        return true;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      await Bun.sleep(1_000);
    }
  }
  return false;
}

/**
 * Deterministic reviewer explorer. Runs only inside the Vercel sandbox after
 * the deterministic steps pass. It can start the app, probe HTTP endpoints,
 * run one read-only schema query, and capture capped app logs. It never calls
 * Neon or GitHub management APIs and never changes the step outcome.
 */
async function runReviewer(input: {
  sandbox: SandboxClient;
  contract: PreviewContract | null;
  env: Record<string, string>;
  cwd: string;
  options: SandboxOptions;
  dependencies: VercelSandboxDependencies;
  stepsOk: boolean;
}): Promise<ReviewerResult | undefined> {
  const { sandbox, contract, env, cwd, options, dependencies, stepsOk } = input;
  const reviewOptions = options.review;
  if (!reviewOptions?.enabled) return undefined;

  const budget = reviewBudget(options);
  const startedAt = Date.now();
  const deadline = startedAt + budget.timeoutMs;
  const remaining = () => Math.max(0, deadline - Date.now());

  if (!stepsOk) return skippedReview("deterministic steps failed", budget);
  if (!contract?.app) return skippedReview("contract has no app command", budget);
  if (options.signal?.aborted) return skippedReview("run was cancelled", budget);
  if (!sandbox.domain) {
    return skippedReview("sandbox does not expose app domains", budget);
  }

  const app = contract.app;
  const findings: ReviewFinding[] = [];
  const fetchImpl = dependencies.reviewFetch ?? fetch;
  let appUrl: string | null = null;
  let appPid: string | null = null;

  const finish = (status: ReviewerResult["status"], reason?: string): ReviewerResult => ({
    ran: true,
    status,
    reason,
    appUrl,
    appPort: app.port,
    findings,
    durationMs: Date.now() - startedAt,
    budget,
  });

  try {
    appUrl = sandbox.domain(app.port);

    const start = await runReviewCommand(
      sandbox,
      `nohup ${app.command} > ${REVIEW_APP_LOG} 2>&1 & echo $!`,
      env,
      cwd,
      Math.min(15_000, remaining()),
      1_000,
      options.signal,
    );
    appPid = start.output.trim().split(/\s+/).at(0) ?? null;

    findings.push({
      kind: "app",
      title: "Start preview app",
      status: start.exitCode === 0 && appPid ? "ok" : "failed",
      detail: start.exitCode === 0 && appPid ? `pid ${appPid}` : start.output || "process did not report a pid",
    });

    if (start.exitCode !== 0 || !appPid) {
      findings.push({
        kind: "app",
        title: "App readiness",
        status: "skipped",
        detail: "app process did not start",
      });
    } else {
      const ready = await waitForApp(fetchImpl, appUrl, Math.min(deadline, Date.now() + 30_000), options.signal);
      findings.push({
        kind: "app",
        title: "App readiness",
        status: ready ? "ok" : "failed",
        detail: ready ? `responded on port ${app.port}` : "no HTTP response before the readiness deadline",
      });
    }

    if (appUrl) {
      for (const path of normalizePaths(reviewOptions.paths)) {
        if (remaining() <= 0) {
          findings.push({ kind: "http", title: `GET ${path}`, status: "skipped", detail: "reviewer budget exhausted" });
          continue;
        }
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), Math.min(5_000, remaining()));
          let response: Response;
          try {
            response = await fetchImpl(`${appUrl}${path}`, { signal: controller.signal });
          } finally {
            clearTimeout(timer);
          }
          const body = await response.text().catch(() => "");
          findings.push({
            kind: "http",
            title: `GET ${path}`,
            status: response.status < 400 ? "ok" : "failed",
            detail: `HTTP ${response.status}`,
            evidence: capOutput(body.trim(), budget.maxOutputChars) || undefined,
          });
        } catch (error) {
          findings.push({
            kind: "http",
            title: `GET ${path}`,
            status: "failed",
            detail: errorMessage(error),
          });
        }
      }
    }

    if (contract.database.required && env.DATABASE_URL) {
      const dbCommand = [
        `cat > ${REVIEW_DB_SCRIPT} <<'EOF'`,
        "const sql = new Bun.SQL(process.env.DATABASE_URL);",
        "const rows = await sql`select table_name from information_schema.tables where table_schema='public' order by table_name limit 20`;",
        "console.log(JSON.stringify(rows));",
        "await sql.end();",
        "EOF",
        `bun run ${REVIEW_DB_SCRIPT}`,
      ].join("\n");

      try {
        const db = await runReviewCommand(
          sandbox,
          dbCommand,
          env,
          cwd,
          Math.min(15_000, remaining()),
          budget.maxOutputChars,
          options.signal,
        );
        findings.push({
          kind: "db",
          title: "Read preview schema (tables)",
          status: db.exitCode === 0 ? "ok" : "failed",
          detail: db.exitCode === 0 ? "select executed" : db.output || "schema query failed",
          evidence: db.exitCode === 0 ? db.output || undefined : undefined,
        });
      } catch (error) {
        findings.push({
          kind: "db",
          title: "Read preview schema (tables)",
          status: "failed",
          detail: errorMessage(error),
        });
      }
    } else {
      findings.push({
        kind: "db",
        title: "Read preview schema (tables)",
        status: "skipped",
        detail: contract.database.required
          ? "DATABASE_URL was not provided to the reviewer"
          : "contract does not require a database",
      });
    }

    try {
      const logs = await runReviewCommand(
        sandbox,
        `tail -n 50 ${REVIEW_APP_LOG}`,
        env,
        cwd,
        Math.min(5_000, remaining()),
        budget.maxOutputChars,
        options.signal,
      );
      findings.push({
        kind: "log",
        title: "App logs",
        status: logs.exitCode === 0 ? "ok" : "failed",
        evidence: logs.output || undefined,
      });
    } catch (error) {
      findings.push({
        kind: "log",
        title: "App logs",
        status: "failed",
        detail: errorMessage(error),
      });
    }

    return finish(findings.some((finding) => finding.status === "failed") ? "failed" : "ok");
  } catch (error) {
    findings.push({ kind: "app", title: "Reviewer", status: "failed", detail: errorMessage(error) });
    return finish("failed", errorMessage(error));
  } finally {
    if (appPid) {
      try {
        await sandbox.runCommand({
          cmd: "sh",
          args: ["-c", `kill ${appPid} 2>/dev/null || true`],
          cwd,
          env,
          timeoutMs: 2_000,
        });
      } catch {
        // The sandbox is deleted immediately after; the VM kills the process.
      }
    }
    appUrl = appUrl; // Kept in the artifact as the ephemeral preview URL.
  }
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

  const reviewEnabled = options.review?.enabled === true;
  const reviewAppPort = reviewEnabled && contract?.app ? contract.app.port : undefined;

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
    ...(reviewAppPort ? { ports: [reviewAppPort] } : {}),
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

    const budget = reviewBudget(options);
    if (options.review?.enabled) {
      const review = await runReviewer({
        sandbox,
        contract,
        env,
        cwd: remote.directory,
        options,
        dependencies,
        stepsOk: result.error === null,
      });
      result.review = review;
      if (review) {
        log(
          `[sandbox] reviewer ${review.status}` +
            (review.appUrl ? ` at ${review.appUrl}` : ""),
        );
      }
    } else if (budget) {
      result.review = undefined;
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
