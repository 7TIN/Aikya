import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createDatabase } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { printSmokeResult, runSmoke, type SmokeResult } from "../db/smoke.ts";
import {
  listEnvironments,
  resolveEnvironment,
  type EnvironmentDefinition,
} from "../env/environments.ts";
import {
  bold,
  dim,
  formatBytes,
  formatBytesDelta,
  formatDate,
  formatNumber,
  formatSigned,
  paint,
  renderTable,
} from "../lib/format.ts";
import {
  branchConnectionString,
  createBranch,
  listBranches,
  resetBranchToParent,
  type NeonBranch,
} from "./branches.ts";
import { buildBranchReport, type BranchReport } from "./report.ts";

export interface EnsureEnvironmentResult {
  environment: EnvironmentDefinition;
  branch: NeonBranch;
  created: boolean;
}

export interface ResetStep {
  name: string;
  status: "ok" | "failed" | "skipped";
  detail?: string;
}

export type ResetStatus = "created" | "reset" | "planned" | "failed";

export interface ResetEnvironmentResult {
  status: ResetStatus;
  environment: EnvironmentDefinition;
  existed: boolean;
  preResetReport?: BranchReport;
  smoke?: SmokeResult;
  steps: ResetStep[];
  artifacts?: {
    dir: string;
    preResetPath?: string;
    smokePath?: string;
  };
  error?: string;
}

export interface ResetEnvironmentOptions {
  name: string;
  /** Required to replace an existing branch; creation alone is non-destructive. */
  yes?: boolean;
  /** Show the pre-reset report and plan without changing anything. */
  dryRun?: boolean;
  skipSmoke?: boolean;
  artifactsDir?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function findBranch(
  branches: NeonBranch[],
  name: string,
): NeonBranch | undefined {
  return branches.find((branch) => branch.name === name);
}

function ensureParent(
  branches: NeonBranch[],
  environment: EnvironmentDefinition,
): NeonBranch {
  const parent = findBranch(branches, environment.parent);
  if (!parent) {
    throw new Error(
      `Parent branch "${environment.parent}" for ${environment.name} was not found. ` +
        "Run `bun run branch:list`.",
    );
  }
  return parent;
}

async function ensureWithBranches(
  environment: EnvironmentDefinition,
  branches: NeonBranch[],
): Promise<EnsureEnvironmentResult> {
  ensureParent(branches, environment);

  const existing = findBranch(branches, environment.name);
  if (existing) return { environment, branch: existing, created: false };

  const branch = await createBranch({
    name: environment.name,
    parent: environment.parent,
  });
  return { environment, branch, created: true };
}

/** Create one persistent environment branch if it does not exist. */
export async function ensureEnvironment(
  name: string,
): Promise<EnsureEnvironmentResult> {
  const environment = resolveEnvironment(name);
  const branches = await listBranches();
  return ensureWithBranches(environment, branches);
}

/** Create every defined environment branch, skipping existing ones. */
export async function ensureAllEnvironments(): Promise<
  EnsureEnvironmentResult[]
> {
  const branches = await listBranches();
  const results: EnsureEnvironmentResult[] = [];
  for (const environment of listEnvironments()) {
    results.push(await ensureWithBranches(environment, branches));
  }
  return results;
}

function artifactDir(name: string, overrideDir?: string): string {
  const raw =
    overrideDir ??
    fileURLToPath(
      new URL(`../../artifacts/environments/${name}/`, import.meta.url),
    );
  return raw.replace(/\\/g, "/").replace(/\/+$/, "");
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/**
 * Refresh a long-lived environment:
 *
 *   pre-reset report → reset to parent (or create) → migrate → smoke test
 *
 * `main` and arbitrary branches are rejected by the environment allowlist.
 * An existing branch is only replaced with `--yes`; without it the command
 * behaves as a dry run and still writes the pre-reset snapshot.
 */
export async function resetEnvironment(
  options: ResetEnvironmentOptions,
): Promise<ResetEnvironmentResult> {
  const environment = resolveEnvironment(options.name);
  const steps: ResetStep[] = [];
  const dir = artifactDir(environment.name, options.artifactsDir);

  let branches: NeonBranch[];
  try {
    branches = await listBranches();
  } catch (error) {
    return {
      status: "failed",
      environment,
      existed: false,
      steps: [{ name: "list branches", status: "failed", detail: errorMessage(error) }],
      error: errorMessage(error),
    };
  }

  const parent = findBranch(branches, environment.parent);
  if (!parent) {
    const message = `Parent branch "${environment.parent}" was not found. Run \`bun run branch:list\`.`;
    return {
      status: "failed",
      environment,
      existed: false,
      steps: [{ name: "resolve parent", status: "failed", detail: message }],
      error: message,
    };
  }

  const existing = findBranch(branches, environment.name);
  const existed = Boolean(existing);

  if (existing?.default || existing?.primary || existing?.protected) {
    const message = `Branch "${environment.name}" is marked default, primary, or protected; refusing to reset it.`;
    return {
      status: "failed",
      environment,
      existed,
      steps: [{ name: "safety check", status: "failed", detail: message }],
      error: message,
    };
  }

  let preResetReport: BranchReport | undefined;
  const artifacts: NonNullable<ResetEnvironmentResult["artifacts"]> = { dir };

  if (existing) {
    try {
      preResetReport = await buildBranchReport({
        branch: environment.name,
        parent: environment.parent,
      });
      steps.push({
        name: "pre-reset report",
        status: "ok",
        detail: `${formatBytesDelta(preResetReport.sizeDeltaBytes)} delta, ${formatSigned(preResetReport.rowDelta)} rows`,
      });

      await mkdir(dir, { recursive: true });
      artifacts.preResetPath = `${dir}/pre-reset.json`;
      await writeJson(artifacts.preResetPath, {
        environment: environment.name,
        parent: environment.parent,
        capturedAt: new Date().toISOString(),
        report: preResetReport,
      });
    } catch (error) {
      steps.push({
        name: "pre-reset report",
        status: "failed",
        detail: errorMessage(error),
      });
    }
  } else {
    steps.push({
      name: "pre-reset report",
      status: "skipped",
      detail: "branch does not exist yet",
    });
  }

  if (options.dryRun || (existed && !options.yes)) {
    steps.push({
      name: existed ? "reset to parent" : "create branch",
      status: "skipped",
      detail: existed
        ? "pass --yes to replace this environment"
        : "dry run",
    });
    return {
      status: "planned",
      environment,
      existed,
      preResetReport,
      steps,
      artifacts,
    };
  }

  let action: "reset" | "created";
  try {
    if (existing) {
      await resetBranchToParent(environment.name);
      steps.push({
        name: "reset to parent",
        status: "ok",
        detail: `restored from ${environment.parent}`,
      });
      action = "reset";
    } else {
      await createBranch({
        name: environment.name,
        parent: environment.parent,
      });
      steps.push({
        name: "create branch",
        status: "ok",
        detail: `from ${environment.parent} (no expiry)`,
      });
      action = "created";
    }
  } catch (error) {
    const message = errorMessage(error);
    steps.push({
      name: existing ? "reset to parent" : "create branch",
      status: "failed",
      detail: message,
    });
    return {
      status: "failed",
      environment,
      existed,
      preResetReport,
      steps,
      artifacts,
      error: message,
    };
  }

  let branchUrl: string;
  try {
    branchUrl = await branchConnectionString(environment.name, {
      pooled: false,
    });
  } catch (error) {
    const message = errorMessage(error);
    steps.push({ name: "connection string", status: "failed", detail: message });
    return {
      status: "failed",
      environment,
      existed,
      preResetReport,
      steps,
      artifacts,
      error: message,
    };
  }

  const handle = createDatabase(branchUrl);
  try {
    await runMigrations(handle.db);
    steps.push({ name: "migrate", status: "ok", detail: "migrations applied" });
  } catch (error) {
    steps.push({
      name: "migrate",
      status: "failed",
      detail: errorMessage(error),
    });
  } finally {
    await handle.client.end();
  }

  let smoke: SmokeResult | undefined;
  if (steps.some((step) => step.status === "failed")) {
    steps.push({
      name: "smoke test",
      status: "skipped",
      detail: "a previous step failed",
    });
  } else if (options.skipSmoke) {
    steps.push({ name: "smoke test", status: "skipped", detail: "--skip-smoke" });
  } else {
    try {
      smoke = await runSmoke({
        branch: environment.name,
        url: branchUrl,
        requiredTables: environment.requiredTables,
      });
      steps.push({
        name: "smoke test",
        status: smoke.pass ? "ok" : "failed",
        detail: smoke.pass
          ? `${smoke.checks.length} checks passed`
          : "one or more checks failed",
      });

      await mkdir(dir, { recursive: true });
      artifacts.smokePath = `${dir}/smoke.json`;
      await writeJson(artifacts.smokePath, smoke);
    } catch (error) {
      steps.push({
        name: "smoke test",
        status: "failed",
        detail: errorMessage(error),
      });
    }
  }

  const failed = steps.some((step) => step.status === "failed");
  return {
    status: failed ? "failed" : action,
    environment,
    existed,
    preResetReport,
    smoke,
    steps,
    artifacts,
    error: failed
      ? (steps.find((step) => step.status === "failed")?.detail ??
        "reset failed")
      : undefined,
  };
}

export function printEnsureResults(results: EnsureEnvironmentResult[]): void {
  console.log("");
  console.log(bold(paint("cyan", "Environment branches")));
  console.log("─".repeat(96));
  console.log(
    renderTable(
      ["name", "parent", "state", "logical size", "result"],
      results.map((result) => [
        result.environment.name,
        result.environment.parent,
        result.branch.currentState,
        result.branch.logicalSize > 0
          ? formatBytes(result.branch.logicalSize)
          : "n/a",
        result.created ? "created" : "exists",
      ]),
    ),
  );
  console.log(
    dim(
      "\nEnvironment branches have no expiry; they are excluded from branch:prune.",
    ),
  );
  console.log("");
}

export function printResetResult(result: ResetEnvironmentResult): void {
  console.log("");
  console.log(bold(paint("cyan", "Environment reset")));
  console.log("─".repeat(72));
  console.log(
    `Environment  ${bold(result.environment.name)} ${dim(`(parent ${result.environment.parent})`)}`,
  );
  console.log(
    `Status       ${
      result.status === "failed"
        ? paint("red", "✖ FAILED")
        : result.status === "planned"
          ? paint("yellow", "→ PLANNED")
          : paint("green", `✔ ${result.status.toUpperCase()}`)
    }`,
  );

  if (result.preResetReport) {
    const report = result.preResetReport;
    console.log("");
    console.log(bold("Pre-reset snapshot"));
    console.log(
      `Storage      ${formatBytesDelta(report.sizeDeltaBytes)} ${dim("(branch-local since creation)")}`,
    );
    console.log(
      `Rows         ${formatNumber(report.base.totalRows)} → ${formatNumber(report.compare.totalRows)} (${formatSigned(report.rowDelta)})`,
    );
    console.log(
      `Writes       +${formatNumber(report.branchWrites.inserts)} ins / +${formatNumber(report.branchWrites.updates)} upd / ${formatNumber(report.branchWrites.deletes)} del`,
    );
    console.log(
      `Schema       ${report.schemaDiff.hasChanges ? paint("yellow", "changes detected") : dim("no changes")}`,
    );
    if (report.branch.createdAt) {
      console.log(`Branch age   since ${formatDate(report.branch.createdAt)}`);
    }
  }

  if (result.steps.length > 0) {
    console.log("");
    for (const step of result.steps) {
      const mark =
        step.status === "ok"
          ? paint("green", "✔")
          : step.status === "failed"
            ? paint("red", "✖")
            : dim("·");
      console.log(`${mark} ${step.name}${step.detail ? ` ${dim(`(${step.detail})`)}` : ""}`);
    }
  }

  if (result.smoke) {
    console.log("");
    printSmokeResult(result.smoke);
  }

  if (result.status === "planned") {
    console.log(
      dim(
        result.existed
          ? "Dry run. Re-run with --yes to reset this environment to its parent."
          : "Dry run. Re-run without --dry-run to create this environment.",
      ),
    );
  }

  if (result.artifacts) {
    console.log(dim(`Artifacts    ${result.artifacts.dir}`));
  }

  if (result.error && result.status !== "planned") {
    console.log("");
    console.log(paint("red", result.error));
  }

  console.log("");
}
