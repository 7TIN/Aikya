import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createEventLog, type EventLog } from "../events/log.ts";
import type {
  QaCheckResult,
  QaReport,
  QaRunStatus,
  QaSandboxKind,
  QaStep,
  QaUsage,
} from "./types.ts";

/**
 * Report writing for the QA agent. The JSON and patch are local artifacts
 * (`artifacts/qa/`, already gitignored); the event log entry is what the
 * dashboard reads.
 */

export interface BuildQaReportInput {
  mode: "checks" | "agent";
  sandbox: QaSandboxKind;
  model: string | null;
  startedAt: number;
  checks: QaCheckResult[];
  steps?: QaStep[];
  patch?: string;
  filesChanged?: string[];
  status: QaRunStatus;
  reason?: string | null;
  summary?: string | null;
  usage?: QaUsage;
}

export function createReportId(now = Date.now()): string {
  const stamp = new Date(now)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  const suffix = Math.random().toString(36).slice(2, 6);
  return `qa-${stamp}-${suffix}`;
}

export function buildQaReport(input: BuildQaReportInput): QaReport {
  const finishedAt = Date.now();
  return {
    id: createReportId(input.startedAt),
    mode: input.mode,
    sandbox: input.sandbox,
    model: input.model,
    startedAt: new Date(input.startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    status: input.status,
    reason: input.reason ?? null,
    checks: input.checks,
    steps: input.steps ?? [],
    filesChanged: input.filesChanged ?? [],
    patchPath: null,
    patch: input.patch ?? "",
    summary: input.summary ?? null,
    usage:
      input.usage ?? { steps: 0, promptTokens: null, completionTokens: null },
  };
}

export interface WriteQaArtifactsOptions {
  /** Defaults to `AIKYA_QA_DIR` or `artifacts/qa`. */
  dir?: string;
}

export interface QaArtifacts {
  jsonPath: string;
  patchPath: string | null;
}

export async function writeQaArtifacts(
  report: QaReport,
  options: WriteQaArtifactsOptions = {},
): Promise<QaArtifacts> {
  const dir = options.dir ?? process.env.AIKYA_QA_DIR ?? "artifacts/qa";
  await mkdir(dir, { recursive: true });

  let patchPath: string | null = null;
  if (report.patch.trim()) {
    patchPath = join(dir, `${report.id}.patch`);
    await writeFile(patchPath, report.patch, "utf8");
  }
  report.patchPath = patchPath;

  const jsonPath = join(dir, `${report.id}.json`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  return { jsonPath, patchPath };
}

export interface LogQaEventOptions {
  events?: EventLog;
}

/** Append a `qa.completed` event. Never throws into the caller's result. */
export async function logQaEvent(
  report: QaReport,
  options: LogQaEventOptions = {},
): Promise<void> {
  try {
    const events = options.events ?? createEventLog();
    await events.append({
      type: "qa.completed",
      status: report.status,
      durationMs: Math.max(
        0,
        Date.parse(report.finishedAt) - Date.parse(report.startedAt),
      ),
      reason: report.reason ?? undefined,
      detail: {
        mode: report.mode,
        sandbox: report.sandbox,
        model: report.model,
        checks: report.checks.map((check) => ({
          name: check.name,
          status: check.status,
        })),
        steps: report.usage.steps,
        filesChanged: report.filesChanged,
        patchPath: report.patchPath,
        summary: report.summary,
      },
    });
  } catch {
    // The event log is observability, not a correctness boundary.
  }
}
