import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { formatDuration, parseDuration } from "../lib/duration.ts";
import {
  bold,
  dim,
  formatBytes,
  formatNumber,
  formatSigned,
  paint,
} from "../lib/format.ts";
import {
  branchConnectionString,
  createBranch,
  deleteBranch,
  listBranches,
} from "../neon/branches.ts";
import { parentBranchName, type NeonContext } from "../neon/cli.ts";
import { buildBranchReport, type BranchReport } from "../neon/report.ts";
import {
  runSandbox,
  SANDBOX_STEPS,
  type ReviewerOptions,
  type ReviewerResult,
  type SandboxBackend,
  type SandboxOptions,
  type SandboxResult,
  type SandboxStepName,
  type SandboxStepResult,
} from "../preview/sandbox.ts";
import { renderPreviewComment } from "./comment.ts";
import { createEventLog } from "../events/log.ts";
import {
  evaluateQuota,
  formatQuotaUsage,
  type QuotaDecision,
  type QuotaLimits,
} from "../preview/quota.ts";
import {
  parsePreviewEvent,
  parsePullRequestNumber,
  planPreview,
  previewBranchName,
  type PreviewAction,
  type PreviewEvent,
} from "./events.ts";
import {
  commandTail,
  parseTestSummary,
  runCommand,
  type CommandResult,
  type TestSummary,
} from "./run.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DEFAULT_EXPIRES_IN = "7d";

export type PreviewStatus = "ready" | "skipped" | "deleted" | "absent" | "failed";

export type StepStatus = "ok" | "failed" | "skipped";

export interface PreviewStep {
  name: string;
  status: StepStatus;
  detail?: string;
  durationMs?: number;
  /** Captured sandbox output (subject previews), persisted in report.json. */
  output?: string;
}

export interface PreviewTests {
  ran: boolean;
  exitCode: number;
  passed: number | null;
  failed: number | null;
  durationMs: number;
  outputTail: string;
}

export interface PreviewArtifacts {
  dir: string;
  reportPath: string;
  commentPath: string;
}

/** Optional origin metadata when a preview is created by the repo watcher. */
export interface PreviewSource {
  repo?: string;
  title?: string;
  url?: string;
  author?: string;
}

/**
 * W2 execution against a watched repository's own checkout and Neon project.
 * Supplied by the registry; never derived from Aikya's ambient credentials.
 */
export interface SubjectPreviewConfig {
  repo: string;
  neon: NeonContext;
  /** Local path or git URL checked out by the sandbox. */
  source: string;
  /** PR head SHA or other git ref to check out. */
  ref?: string | null;
  parent?: string;
  /** Extra environment merged into the sandbox; DATABASE_URL wins. */
  env?: Record<string, string>;
  steps?: readonly SandboxStepName[];
  stepTimeoutMs?: number;
  /** Execution backend for the checkout. Defaults to local. */
  backend?: SandboxBackend;
  /** Vercel settings when backend is `vercel`. */
  vercel?: SandboxOptions["vercel"];
  /** Advisory reviewer explorer. Opt-in per repo. */
  review?: ReviewerOptions;
  /** Per-repo guardrail caps, evaluated before a branch is created. */
  quota?: Partial<QuotaLimits>;
}

/** Subject metadata recorded in the result so artifacts explain what ran. */
export interface PreviewSubject {
  repo: string;
  projectId: string | null;
  source: string;
  ref: string | null;
  parent: string;
  database: string | null;
  backend: SandboxBackend;
}

export interface PreviewResult {
  pr: number;
  event: PreviewEvent;
  action: PreviewAction;
  status: PreviewStatus;
  branch: string;
  parent: string;
  expiresAt?: string;
  reason: string;
  steps: PreviewStep[];
  tests?: PreviewTests;
  /** Advisory reviewer findings; never changes the deterministic status. */
  review?: ReviewerResult;
  /** Quota check made before this run; present for watched repos. */
  quota?: QuotaDecision;
  report?: BranchReport;
  comment: string;
  artifacts?: PreviewArtifacts;
  source?: PreviewSource;
  subject?: PreviewSubject;
  error?: string;
}

export interface PreviewOptions {
  pr: number | string;
  event: PreviewEvent | string;
  parent?: string;
  /** Full branch name override; sanitized. Defaults to `preview/pr-<n>`. */
  name?: string;
  /** Branch lifetime, for example `7d` or `24h`. */
  expiresIn?: string;
  /** Drop and reseed the branch instead of inheriting + migrating. */
  reset?: boolean;
  /** Simulate a fork PR: secrets are unavailable, so no branch is created. */
  fork?: boolean;
  /** Skip `bun test` (useful for a fast branch-only smoke run). */
  runTests?: boolean;
  /** Override the artifact directory. */
  artifactsDir?: string;
  /** Origin metadata when the preview is created by the repository watcher. */
  source?: PreviewSource;
  /** Override the event-log path (tests). */
  eventLogPath?: string;
  /** Run the watched repo's own contract instead of Aikya's migrations. */
  subject?: SubjectPreviewConfig;
  /** Injectable clock for tests. */
  now?: number;
}

function step(name: string, status: StepStatus, detail?: string, durationMs?: number): PreviewStep {
  return { name, status, detail, durationMs };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function branchExists(branches: Awaited<ReturnType<typeof listBranches>>, name: string): boolean {
  return branches.some((branch) => branch.name === name);
}

function displayTail(result: CommandResult): string {
  return commandTail(result, 15);
}

function tailOf(text: string, lines = 15): string {
  const all = text.split(/\r?\n/);
  return all.slice(Math.max(0, all.length - lines)).join("\n");
}

/** Convert one sandbox step into the preview step shape used by artifacts. */
function sandboxPreviewStep(entry: SandboxStepResult): PreviewStep {
  const name = entry.name === "test" ? "tests" : entry.name;

  if (entry.status === "skipped") {
    return {
      name,
      status: "skipped",
      detail: entry.output || "not configured by the contract",
      durationMs: entry.durationMs,
      output: entry.output,
    };
  }

  if (entry.status === "failed") {
    const reason = entry.timedOut
      ? "timed out"
      : entry.cancelled
        ? "cancelled"
        : entry.exitCode !== null
          ? `exit ${entry.exitCode}`
          : "failed";
    return {
      name,
      status: "failed",
      detail: entry.output ? `${reason}\n${tailOf(entry.output)}` : reason,
      durationMs: entry.durationMs,
      output: entry.output,
    };
  }

  return {
    name,
    status: "ok",
    detail: entry.exitCode === 0 ? "exit 0" : undefined,
    durationMs: entry.durationMs,
    output: entry.output,
  };
}

function sandboxTests(result: SandboxResult): PreviewTests | undefined {
  const test = result.steps.find((entry) => entry.name === "test");
  if (!test || test.status === "skipped") return undefined;

  const summary = parseTestSummary(test.output);
  return {
    ran: true,
    exitCode: test.exitCode ?? 1,
    passed: summary.passed,
    failed: summary.failed,
    durationMs: test.durationMs,
    outputTail: tailOf(test.output),
  };
}

/**
 * Run the local equivalent of the GitHub Actions preview job:
 *
 *   opened/reopened → create preview/pr-<n>
 *   synchronize    → delete + recreate
 *   closed         → delete
 *
 * Aikya's own project inherits the parent database and applies Aikya's
 * migrations. A watched repo (`subject`) instead creates the branch in its own
 * Neon project and runs the PR checkout's own contract in the W1 sandbox.
 */
export async function runPreview(options: PreviewOptions): Promise<PreviewResult> {
  const pr = parsePullRequestNumber(options.pr);
  const event = parsePreviewEvent(options.event);
  const subject = options.subject;
  if (subject && !options.name) {
    throw new Error(
      "A subject preview needs a repo-scoped branch name, for example preview/<owner>-<repo>-pr-<n>.",
    );
  }

  const parent = options.parent ?? subject?.parent ?? parentBranchName();
  const branch = previewBranchName(pr, options.name);
  const plan = planPreview(event, { fork: options.fork });
  const steps: PreviewStep[] = [];
  const events = createEventLog(options.eventLogPath);
  const startedAt = Date.now();

  const subjectMetadata: PreviewSubject | undefined = subject
    ? {
        repo: subject.repo,
        projectId: subject.neon.projectId ?? null,
        source: subject.source,
        ref: subject.ref ?? null,
        parent,
        database: subject.neon.database ?? null,
        backend: subject.backend ?? "local",
      }
    : undefined;

  const base = {
    pr,
    event,
    action: plan.action,
    branch,
    parent,
    reason: plan.reason,
    steps,
    comment: "",
    source: options.source,
    subject: subjectMetadata,
  } satisfies Partial<PreviewResult> & Pick<PreviewResult, "pr" | "event" | "action" | "branch" | "parent" | "reason" | "steps">;

  if (plan.action === "skip") {
    steps.push(step("create branch", "skipped", plan.reason));
    return finalize(
      {
        ...base,
        status: "skipped",
        comment: "",
      },
      options.artifactsDir,
    );
  }

  let branches: Awaited<ReturnType<typeof listBranches>>;
  try {
    branches = await listBranches(subject?.neon);
  } catch (error) {
    const message = errorMessage(error);
    return finalize(
      {
        ...base,
        status: "failed",
        comment: "",
        error: message,
        steps: [step("list branches", "failed", message)],
      },
      options.artifactsDir,
    );
  }

  const exists = branchExists(branches, branch);

  if (!branchExists(branches, parent)) {
    return finalize(
      {
        ...base,
        status: "failed",
        comment: "",
        error: `Parent branch "${parent}" was not found. Run \`bun run branch:list\`.`,
        steps: [step("resolve parent", "failed", `branch "${parent}" not found`)],
      },
      options.artifactsDir,
    );
  }

  if (plan.action === "delete") {
    if (!exists) {
      steps.push(step("delete branch", "skipped", "branch already absent"));
      return finalize(
        {
          ...base,
          status: "absent",
          comment: "",
        },
        options.artifactsDir,
      );
    }

    try {
      const startedAt = Date.now();
      await deleteBranch(branch, subject?.neon);
      steps.push(step("delete branch", "ok", "removed", Date.now() - startedAt));
      await events.append({
        type: "branch.deleted",
        repo: subject?.repo,
        pr,
        branch,
        status: "deleted",
        durationMs: Date.now() - startedAt,
      });
      return finalize(
        {
          ...base,
          status: "deleted",
          comment: "",
        },
        options.artifactsDir,
      );
    } catch (error) {
      const message = errorMessage(error);
      steps.push(step("delete branch", "failed", message));
      return finalize(
        {
          ...base,
          status: "failed",
          comment: "",
          error: message,
        },
        options.artifactsDir,
      );
    }
  }

  // W4 guardrail: refuse before touching an existing branch. A refused sync
  // leaves the current preview intact instead of destroying it.
  let quota: QuotaDecision | undefined;
  if (subject) {
    const subjectEvents = await events.load({ repo: subject.repo, limit: 2_000 });
    quota = evaluateQuota({
      repo: subject.repo,
      branches,
      events: subjectEvents,
      limits: subject.quota,
      addBranch: !exists,
      now: options.now,
    });

    if (!quota.allowed) {
      const message = quota.message ?? `Quota exceeded for ${subject.repo}.`;
      steps.push(step("quota", "failed", message));
      await events.append({
        type: "quota.exceeded",
        repo: subject.repo,
        pr,
        branch,
        status: "refused",
        reason: message,
        detail: { usage: quota.usage, limits: quota.limits },
      });
      return finalize(
        {
          ...base,
          status: "failed",
          quota,
          error: message,
        },
        options.artifactsDir,
      );
    }

    steps.push(step("quota", "ok", formatQuotaUsage(quota)));
  }

  const expiresIn = options.expiresIn ?? DEFAULT_EXPIRES_IN;
  const expiresAt = new Date(
    (options.now ?? Date.now()) + parseDuration(expiresIn),
  ).toISOString();

  let branchUrl: string;
  try {
    if (exists) {
      const startedAt = Date.now();
      await deleteBranch(branch, subject?.neon);
      steps.push(
        step(
          "delete existing branch",
          "ok",
          `replaced stale ${branch}`,
          Date.now() - startedAt,
        ),
      );
    }

    const startedAt = Date.now();
    await createBranch({
      name: branch,
      parent,
      expiresAt,
      context: subject?.neon,
    });
    steps.push(
      step(
        "create branch",
        "ok",
        `from ${parent}, expires ${expiresAt}`,
        Date.now() - startedAt,
      ),
    );
    await events.append({
      type: "branch.created",
      repo: subject?.repo,
      pr,
      branch,
      headSha: subject?.ref ?? undefined,
      status: "created",
      durationMs: Date.now() - startedAt,
      detail: { parent, expiresAt },
    });

    branchUrl = await branchConnectionString(branch, {
      pooled: false,
      context: subject?.neon,
    });
  } catch (error) {
    const message = errorMessage(error);
    steps.push(step("create branch", "failed", message));
    return finalize(
      {
        ...base,
        status: "failed",
        expiresAt,
        comment: "",
        error: message,
      },
      options.artifactsDir,
    );
  }

  let failed = false;
  let tests: PreviewTests | undefined;
  let review: ReviewerResult | undefined;
  let processError: string | undefined;

  if (subject) {
    // A watched repo runs its own checkout. DATABASE_URL is written last so a
    // subject env file can never redirect the run to a different branch.
    const env = {
      ...(subject.env ?? {}),
      DATABASE_URL: branchUrl,
      DATABASE_URL_UNPOOLED: branchUrl,
      NEON_BRANCH: branch,
    };
    const requested = [...(subject.steps ?? SANDBOX_STEPS)];
    if (options.runTests === false && requested.includes("test")) {
      requested.splice(requested.indexOf("test"), 1);
    }

    const sandbox = await runSandbox({
      source: subject.source,
      backend: subject.backend,
      ref: subject.ref ?? undefined,
      steps: requested,
      stepTimeoutMs: subject.stepTimeoutMs,
      env,
      vercel: subject.vercel,
      review: subject.review,
    });

    steps.push(...sandbox.steps.map(sandboxPreviewStep));
    tests = sandboxTests(sandbox);
    review = sandbox.review;
    failed = !sandbox.ok;
    processError = sandbox.error ?? undefined;
  } else {
    const env = {
      DATABASE_URL: branchUrl,
      DATABASE_URL_UNPOOLED: branchUrl,
      NEON_BRANCH: branch,
    };
    const secrets = [branchUrl];

    // Inherit + migrate by default; --reset replaces the schema and reseeds.
    const prepareScript = options.reset
      ? "src/db/reset.ts"
      : "src/db/migrate.ts";
    const prepareName = options.reset ? "reset (migrate + seed)" : "migrate";

    const prepare = await runCommand([process.execPath, "run", prepareScript], {
      cwd: ROOT,
      env,
      secrets,
    });

    if (prepare.exitCode === 0) {
      steps.push(
        step(
          prepareName,
          "ok",
          options.reset ? "schema dropped and reseeded" : "migrations applied",
          prepare.durationMs,
        ),
      );
    } else {
      failed = true;
      steps.push(
        step(prepareName, "failed", displayTail(prepare), prepare.durationMs),
      );
    }

    if (options.runTests !== false && !failed) {
      const testsResult = await runCommand([process.execPath, "test"], {
        cwd: ROOT,
        env,
        secrets,
      });
      const summary = parseTestSummary(`${testsResult.stdout}\n${testsResult.stderr}`);
      tests = {
        ran: true,
        exitCode: testsResult.exitCode,
        passed: summary.passed,
        failed: summary.failed,
        durationMs: testsResult.durationMs,
        outputTail: displayTail(testsResult),
      };

      if (testsResult.exitCode === 0) {
        steps.push(
          step(
            "tests",
            "ok",
            `${formatNumber(tests.passed ?? 0)} passed`,
            testsResult.durationMs,
          ),
        );
      } else {
        failed = true;
        steps.push(
          step(
            "tests",
            "failed",
            `${formatNumber(tests.failed ?? 0)} failed; ${formatNumber(tests.passed ?? 0)} passed`,
            testsResult.durationMs,
          ),
        );
      }
    } else if (options.runTests === false) {
      steps.push(step("tests", "skipped", "--no-tests"));
    } else {
      steps.push(step("tests", "skipped", "preparation failed"));
    }
  }

  // The report is best-effort: it still helps debug a failed migration.
  let report: BranchReport | undefined;
  try {
    const startedAt = Date.now();
    report = await buildBranchReport({
      branch,
      parent,
      context: subject?.neon,
    });
    steps.push(
      step(
        "report",
        "ok",
        `${formatSigned(report.rowDelta)} rows, ${formatBytes(report.sizeDeltaBytes)}`,
        Date.now() - startedAt,
      ),
    );
    await events.append({
      type: "branch.report",
      repo: subject?.repo,
      pr,
      branch,
      status: "ok",
      durationMs: Date.now() - startedAt,
      detail: {
        rowDelta: report.rowDelta,
        sizeDeltaBytes: report.sizeDeltaBytes,
        hasSchemaChanges: report.schemaDiff.hasChanges,
      },
    });
  } catch (error) {
    const message = errorMessage(error);
    steps.push(step("report", "failed", message));
    // The branch may still be usable, but a missing report is a failed run.
    failed = true;
  }

  const result: PreviewResult = {
    ...base,
    status: failed ? "failed" : "ready",
    expiresAt,
    steps,
    tests,
    review,
    quota,
    report,
    comment: "",
    error: processError,
  };

  if (review) {
    await events.append({
      type: "review.completed",
      repo: subject?.repo,
      pr,
      branch,
      status: review.status,
      durationMs: review.durationMs,
      detail: {
        appPort: review.appPort,
        findings: review.findings.map((finding) => ({
          kind: finding.kind,
          title: finding.title,
          status: finding.status,
        })),
      },
    });
  }

  await events.append({
    type: "sync.finished",
    repo: subject?.repo,
    pr,
    branch,
    status: result.status,
    durationMs: Date.now() - startedAt,
    reason: result.error ?? undefined,
  });

  return finalize(result, options.artifactsDir);
}

/**
 * Render the sticky comment and write both artifacts. Every outcome writes
 * them, including skips and cleanup, so the GitHub workflow can post a comment
 * without special-casing the event.
 */
async function finalize(
  result: PreviewResult,
  artifactsDir?: string,
): Promise<PreviewResult> {
  result.artifacts = await writeArtifacts(result, artifactsDir);
  result.comment = renderPreviewComment(result);
  await writeFile(result.artifacts.commentPath, `${result.comment}\n`, "utf8");
  return result;
}

async function writeArtifacts(
  result: PreviewResult,
  overrideDir?: string,
): Promise<PreviewArtifacts> {
  const rawDir =
    overrideDir ??
    fileURLToPath(
      new URL(`../../artifacts/preview/pr-${result.pr}/`, import.meta.url),
    );
  const dir = rawDir.replace(/\\/g, "/").replace(/\/+$/, "");

  await mkdir(dir, { recursive: true });
  const reportPath = `${dir}/report.json`;
  const commentPath = `${dir}/comment.md`;

  // The JSON is the machine-readable record; `finalize` renders comment.md
  // after the artifact paths exist.
  await writeFile(
    reportPath,
    `${JSON.stringify({ ...result, comment: undefined }, null, 2)}\n`,
    "utf8",
  );

  return { dir, reportPath, commentPath };
}

export function printPreviewResult(result: PreviewResult): void {
  const icon: Record<PreviewStatus, string> = {
    ready: paint("green", "✔"),
    skipped: paint("yellow", "→"),
    deleted: paint("green", "✔"),
    absent: dim("·"),
    failed: paint("red", "✖"),
  };

  console.log("");
  console.log(bold(paint("cyan", "Database preview")));
  console.log("─".repeat(72));
  console.log(`PR         #${result.pr} (${result.event})`);
  if (result.source?.repo) console.log(`Repo       ${result.source.repo}`);
  if (result.source?.title) console.log(`Title      ${result.source.title}`);
  if (result.subject) {
    console.log(`Subject    ${result.subject.repo} ${dim("(watched repo contract)")}`);
    console.log(`Backend    ${result.subject.backend}`);
    if (result.subject.projectId) {
      console.log(`Project    ${result.subject.projectId}`);
    }
    if (result.subject.database) {
      console.log(`Database   ${result.subject.database}`);
    }
    if (result.subject.ref) {
      console.log(`Commit     ${result.subject.ref.slice(0, 12)}`);
    }
  }
  console.log(`Status     ${icon[result.status]} ${result.status.toUpperCase()}`);
  console.log(`Branch     ${bold(result.branch)} ${dim(`(parent ${result.parent})`)}`);
  if (result.expiresAt) console.log(`Expires    ${result.expiresAt}`);
  console.log(`Action     ${result.action} — ${result.reason}`);
  if (result.quota) {
    console.log(
      `Quota      ${result.quota.allowed ? paint("green", "ok") : paint("red", "exceeded")} ${dim(formatQuotaUsage(result.quota))}`,
    );
  }

  if (result.steps.length > 0) {
    console.log("");
    for (const entry of result.steps) {
      const mark =
        entry.status === "ok"
          ? paint("green", "✔")
          : entry.status === "failed"
            ? paint("red", "✖")
            : dim("·");
      const timing =
        entry.durationMs === undefined
          ? ""
          : dim(` (${formatDuration(entry.durationMs)})`);
      console.log(`${mark} ${entry.name}${timing}`);
      if (entry.detail) {
        const detail = entry.detail.split(/\r?\n/).slice(0, 6).join("\n    ");
        console.log(`    ${dim(detail)}`);
      }
    }
  }

  if (result.tests?.ran && result.tests.exitCode !== 0) {
    console.log("");
    console.log(paint("red", "Test output (tail)"));
    console.log(dim(result.tests.outputTail));
  }

  if (result.review?.ran || result.review?.status === "skipped") {
    const review = result.review;
    console.log("");
    console.log(bold("Advisory reviewer"));
    const mark =
      review.status === "ok"
        ? paint("green", "✔")
        : review.status === "failed"
          ? paint("yellow", "!")
          : dim("·");
    console.log(
      `${mark} ${review.status}${review.appPort ? dim(` :${review.appPort}`) : ""}${review.reason ? dim(` — ${review.reason}`) : ""}`,
    );
    for (const finding of review.findings) {
      const findingMark =
        finding.status === "ok"
          ? paint("green", "✔")
          : finding.status === "failed"
            ? paint("yellow", "!")
            : dim("·");
      console.log(`  ${findingMark} ${finding.title}${finding.detail ? dim(` — ${finding.detail}`) : ""}`);
    }
  }

  if (result.report) {
    const report = result.report;
    console.log("");
    console.log(bold("Branch delta"));
    console.log(
      `Storage     ${formatBytes(report.sizeDeltaBytes)} ${dim("(new pages since branch creation)")}`,
    );
    console.log(
      `Rows        ${formatNumber(report.base.totalRows)} → ${formatNumber(report.compare.totalRows)} ` +
        `(${formatSigned(report.rowDelta)})`,
    );
    console.log(
      `Writes      +${formatNumber(report.branchWrites.inserts)} ins / ` +
        `+${formatNumber(report.branchWrites.updates)} upd / ` +
        `${formatNumber(report.branchWrites.deletes)} del`,
    );
    console.log(
      `Schema      ${report.schemaDiff.hasChanges ? paint("yellow", "changes detected") : dim("no changes")}`,
    );
  }

  if (result.artifacts) {
    console.log("");
    console.log(dim(`Artifacts   ${result.artifacts.dir}`));
    console.log(dim(`            report.json · comment.md`));
  }

  if (result.error) {
    console.log("");
    console.log(paint("red", result.error));
  }

  console.log("");
}
