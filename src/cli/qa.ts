import { resolve } from "node:path";
import { flagBool, flagString, parseArgs } from "../lib/args.ts";
import { bold, dim, paint } from "../lib/format.ts";
import { runQaChecks } from "../qa/checks.ts";
import { runQaAgent } from "../qa/agent.ts";
import { createOpenAiModel } from "../qa/model.ts";
import {
  buildQaReport,
  logQaEvent,
  writeQaArtifacts,
} from "../qa/report.ts";
import { LocalQaSandbox } from "../qa/sandbox.ts";
import { runQaSmoke } from "../qa/smoke.ts";
import type { QaCheckResult, QaReport, QaRunStatus, QaSandbox } from "../qa/types.ts";
import { VercelQaSandbox } from "../qa/vercel.ts";

/**
 * `bun run qa`            deterministic preflight only
 * `bun run qa:agent`      preflight + bounded fix loop
 * `bun run qa:agent --sandbox vercel --apply`
 */

const { flags } = parseArgs(Bun.argv.slice(2));
const agent = flagBool(flags, "agent");
const json = flagBool(flags, "json");
const apply = flagBool(flags, "apply");
const keep = flagBool(flags, "keep");
const noChecks = flagBool(flags, "no-checks");
const noSmoke = flagBool(flags, "no-smoke");
const noInstall = flagBool(flags, "no-install");
const sandboxKind = (flagString(flags, "sandbox") ?? "local") as "local" | "vercel";
const modelName =
  flagString(flags, "model") ?? process.env.AIKYA_QA_MODEL ?? "gpt-4.1-mini";
const maxSteps = clampInt(
  Number(flagString(flags, "max-steps") ?? process.env.AIKYA_QA_MAX_STEPS ?? 12),
  1,
  40,
  12,
);
const wallMs = clampInt(
  Number(
    flagString(flags, "wall-ms") ?? process.env.AIKYA_QA_TIMEOUT_MS ?? 8 * 60_000,
  ),
  30_000,
  30 * 60_000,
  8 * 60_000,
);
const source = flagString(flags, "source") ?? process.cwd();

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

if (sandboxKind !== "local" && sandboxKind !== "vercel") {
  fail(`--sandbox must be local or vercel, got "${sandboxKind}"`);
}

function fail(message: string): never {
  console.error("");
  console.error(paint("red", message));
  console.error("");
  process.exit(1);
}

function icon(status: QaCheckResult["status"] | QaRunStatus): string {
  if (status === "ok" || status === "fixed") return paint("green", "✔");
  if (status === "skipped") return dim("•");
  return paint("red", "✖");
}

function formatMs(ms: number): string {
  return ms < 1_000 ? `${ms}ms` : `${(ms / 1_000).toFixed(1)}s`;
}

function printReport(report: QaReport): void {
  console.log("");
  console.log(bold(paint("cyan", "Aikya QA")));
  console.log("─".repeat(88));
  console.log(
    `Run         ${report.id}\n` +
      `Sandbox     ${report.sandbox}\n` +
      `Mode        ${report.mode}${report.model ? ` · model ${report.model}` : ""}`,
  );

  if (report.checks.length > 0) {
    console.log("\nPreflight");
    for (const check of report.checks) {
      console.log(
        `  ${icon(check.status)} ${check.name.padEnd(12)} ${formatMs(check.durationMs)}` +
          (check.status === "failed" ? dim(` (exit ${check.exitCode ?? "?"})`) : ""),
      );
    }
  }

  if (report.steps.length > 0) {
    console.log("\nAgent steps");
    for (const step of report.steps) {
      console.log(
        `  ${String(step.index).padStart(2)}. ${step.tool.padEnd(12)} ` +
          `${step.ok ? "ok" : "failed"} · ${step.summary}`,
      );
    }
  }

  if (report.filesChanged.length > 0) {
    console.log(`\nFiles changed (${report.filesChanged.length})`);
    for (const file of report.filesChanged) console.log(`  ${file}`);
  }

  if (report.patchPath) {
    console.log(`\nPatch       ${report.patchPath}`);
  }

  console.log("");
  console.log(
    `${icon(report.status)} ${bold(report.status.toUpperCase())}` +
      (report.summary ? ` — ${report.summary}` : "") +
      (report.reason ? dim(` (${report.reason})`) : ""),
  );
  console.log("");
}

function applyPatch(report: QaReport): void {
  if (!report.patch.trim() || !report.patchPath) {
    console.log(dim("No patch to apply."));
    return;
  }

  const patchPath = resolve(report.patchPath);
  const cwd = resolve(source);
  const check = Bun.spawnSync(["git", "apply", "--check", patchPath], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (check.exitCode !== 0) {
    console.error(
      paint(
        "red",
        `Patch does not apply cleanly: ${check.stderr.toString().trim() || "git apply --check failed"}`,
      ),
    );
    process.exitCode = 1;
    return;
  }

  const result = Bun.spawnSync(["git", "apply", patchPath], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    console.error(paint("red", `git apply failed: ${result.stderr.toString().trim()}`));
    process.exitCode = 1;
    return;
  }

  console.log(paint("green", `Applied ${report.patchPath} to the working tree.`));
  if (!json) {
    console.log(
      dim("Review the diff and commit it yourself; QA never commits or pushes."),
    );
  }
}

const startedAt = Date.now();
const log = json ? () => {} : (line: string) => console.log(dim(line));
let sandbox: QaSandbox | null = null;
let report: QaReport;

try {
  sandbox =
    sandboxKind === "vercel"
      ? await VercelQaSandbox.create({
          source,
          install: !noInstall,
          log,
        })
      : await LocalQaSandbox.create({
          source,
          install: !noInstall,
          log,
        });

  const checks = noChecks ? [] : await runQaChecks(sandbox, { log });
  if (!noChecks && !noSmoke) {
    checks.push(await runQaSmoke(sandbox, { log }));
  }

  if (!agent) {
    const failed = checks.filter((check) => check.status === "failed");
    report = buildQaReport({
      mode: "checks",
      sandbox: sandbox.kind,
      model: null,
      startedAt,
      checks,
      status: failed.length === 0 ? "ok" : "failed",
      reason:
        failed.length === 0
          ? null
          : `${failed.length} check${failed.length === 1 ? "" : "s"} failed`,
    });
  } else {
    const model = createOpenAiModel({ model: modelName });
    log(`[qa] model ${model.model}, max ${maxSteps} steps`);
    const result = await runQaAgent({
      sandbox,
      model,
      checks,
      maxSteps,
      maxWallMs: wallMs,
      log,
    });
    report = buildQaReport({
      mode: "agent",
      sandbox: sandbox.kind,
      model: model.model,
      startedAt,
      checks,
      steps: result.steps,
      patch: result.patch,
      filesChanged: result.filesChanged,
      status: result.status,
      reason: result.reason,
      summary: result.summary,
      usage: result.usage,
    });
  }

  await writeQaArtifacts(report);
  await logQaEvent(report);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  report = buildQaReport({
    mode: agent ? "agent" : "checks",
    sandbox: sandbox?.kind ?? sandboxKind,
    model: agent ? modelName : null,
    startedAt,
    checks: [],
    status: "error",
    reason: message,
  });
  await writeQaArtifacts(report).catch(() => undefined);
  await logQaEvent(report);
  if (!json) printReport(report);
  if (sandbox && !keep) await sandbox.close();
  fail(message);
}

if (json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  printReport(report);
}

if (apply) applyPatch(report);

if (sandbox && !keep) {
  await sandbox.close();
} else if (sandbox && !json) {
  console.log(dim(`Kept sandbox at ${sandbox.root}`));
}

if (report.status !== "ok" && report.status !== "fixed") {
  process.exitCode = 1;
}
