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
import { parentBranchName } from "../neon/cli.ts";
import { buildBranchReport, type BranchReport } from "../neon/report.ts";
import { renderPreviewComment } from "./comment.ts";
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
  report?: BranchReport;
  comment: string;
  artifacts?: PreviewArtifacts;
  source?: PreviewSource;
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

/**
 * Run the local equivalent of the GitHub Actions preview job:
 *
 *   opened/reopened → create preview/pr-<n>
 *   synchronize    → delete + recreate
 *   closed         → delete
 *
 * Inherits the parent database and applies migrations so the PR's migrations
 * are tested against realistic data. `reset` runs migrate + seed from scratch.
 */
export async function runPreview(options: PreviewOptions): Promise<PreviewResult> {
  const pr = parsePullRequestNumber(options.pr);
  const event = parsePreviewEvent(options.event);
  const parent = options.parent ?? parentBranchName();
  const branch = previewBranchName(pr, options.name);
  const plan = planPreview(event, { fork: options.fork });
  const steps: PreviewStep[] = [];

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
    branches = await listBranches();
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
      await deleteBranch(branch);
      steps.push(step("delete branch", "ok", "removed", Date.now() - startedAt));
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

  const expiresIn = options.expiresIn ?? DEFAULT_EXPIRES_IN;
  const expiresAt = new Date(
    (options.now ?? Date.now()) + parseDuration(expiresIn),
  ).toISOString();

  let branchUrl: string;
  try {
    if (exists) {
      const startedAt = Date.now();
      await deleteBranch(branch);
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
    await createBranch({ name: branch, parent, expiresAt });
    steps.push(
      step(
        "create branch",
        "ok",
        `from ${parent}, expires ${expiresAt}`,
        Date.now() - startedAt,
      ),
    );

    branchUrl = await branchConnectionString(branch, { pooled: false });
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

  const env = {
    DATABASE_URL: branchUrl,
    DATABASE_URL_UNPOOLED: branchUrl,
    NEON_BRANCH: branch,
  };
  const secrets = [branchUrl];

  let failed = false;
  let tests: PreviewTests | undefined;

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

  // The report is best-effort: it still helps debug a failed migration.
  let report: BranchReport | undefined;
  try {
    const startedAt = Date.now();
    report = await buildBranchReport({ branch, parent });
    steps.push(
      step(
        "report",
        "ok",
        `${formatSigned(report.rowDelta)} rows, ${formatBytes(report.sizeDeltaBytes)}`,
        Date.now() - startedAt,
      ),
    );
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
    report,
    comment: "",
  };

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
  console.log(`Status     ${icon[result.status]} ${result.status.toUpperCase()}`);
  console.log(`Branch     ${bold(result.branch)} ${dim(`(parent ${result.parent})`)}`);
  if (result.expiresAt) console.log(`Expires    ${result.expiresAt}`);
  console.log(`Action     ${result.action} — ${result.reason}`);

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
