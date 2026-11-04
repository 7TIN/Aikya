import { readdir, readFile, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { fileURLToPath } from "node:url";
import type { NeonBranch } from "../neon/branches.ts";
import { previewBranchPrefix } from "./events.ts";

/**
 * Local view of Phase 2 pull-request previews.
 *
 * Preview runs already write machine-readable artifacts:
 *   artifacts/preview/pr-<n>/report.json
 *   artifacts/preview/pr-<n>/comment.md
 *
 * The dashboard reads those artifacts and joins them with the live Neon branch
 * list, so one page shows the PR, its preview branch, and the branch's current
 * state. Everything here is read-only and tolerant of missing/older artifacts.
 */

export const PREVIEW_STATUSES = [
  "ready",
  "skipped",
  "deleted",
  "absent",
  "failed",
] as const;

export type PreviewStatus =
  | (typeof PREVIEW_STATUSES)[number]
  | "branch-only"
  | "unknown";

export interface PreviewStepSummary {
  name: string;
  status: string;
  detail: string | null;
  durationMs: number | null;
}

export interface PreviewTestsSummary {
  ran: boolean;
  exitCode: number | null;
  passed: number | null;
  failed: number | null;
}

export interface PreviewReportSummary {
  rowsBase: number;
  rowsBranch: number;
  rowDelta: number;
  sizeDeltaBytes: number;
  schemaChanged: boolean;
}

export interface PreviewRecord {
  pr: number | null;
  branch: string;
  parent: string | null;
  event: string | null;
  action: string | null;
  status: PreviewStatus;
  reason: string | null;
  /** Origin repo when the preview came from the repository watcher. */
  repo: string | null;
  title: string | null;
  url: string | null;
  author: string | null;
  expiresAt: string | null;
  /** Artifact write time, used as "last run" in the dashboard. */
  updatedAt: string | null;
  artifactPath: string | null;
  steps: PreviewStepSummary[];
  tests: PreviewTestsSummary | null;
  report: PreviewReportSummary | null;
  comment: string | null;
  error: string | null;
}

export interface PreviewLiveBranch {
  exists: boolean;
  state: string | null;
  logicalSize: number | null;
  writtenDataBytes: number | null;
  createdAt: string | null;
  expiresAt: string | null;
  parentName: string | null;
}

export interface PreviewView extends PreviewRecord {
  live: PreviewLiveBranch;
}

const ARTIFACTS_DIR = fileURLToPath(
  new URL("../../artifacts/preview/", import.meta.url),
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asInteger(value: unknown): number | null {
  const number = asNumber(value);
  return number !== null && Number.isInteger(number) && number > 0
    ? number
    : null;
}

export function normalizePreviewStatus(value: unknown): PreviewStatus {
  return (PREVIEW_STATUSES as readonly string[]).includes(String(value))
    ? (value as PreviewStatus)
    : "unknown";
}

/** `preview/pr-42` or `preview/7tin-gh-lab-pr-42` → 42. */
export function previewNumberFromBranch(name: string): number | null {
  const match = new RegExp(
    `^${previewBranchPrefix()}(?:[a-z0-9._-]+-)?pr-(\\d+)$`,
    "i",
  ).exec(name.trim());
  return match?.[1] ? Number(match[1]) : null;
}

function normalizeSteps(value: unknown): PreviewStepSummary[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((step) => ({
    name: asString(step.name) ?? "step",
    status: asString(step.status) ?? "unknown",
    detail: asString(step.detail),
    durationMs: asNumber(step.durationMs),
  }));
}

function normalizeTests(value: unknown): PreviewTestsSummary | null {
  if (!isRecord(value)) return null;
  return {
    ran: value.ran === true,
    exitCode: asNumber(value.exitCode),
    passed: asNumber(value.passed),
    failed: asNumber(value.failed),
  };
}

function normalizeReport(value: unknown): PreviewReportSummary | null {
  if (!isRecord(value)) return null;
  const base = isRecord(value.base) ? value.base : {};
  const compare = isRecord(value.compare) ? value.compare : {};
  const schemaDiff = isRecord(value.schemaDiff) ? value.schemaDiff : {};
  return {
    rowsBase: asNumber(base.totalRows) ?? 0,
    rowsBranch: asNumber(compare.totalRows) ?? 0,
    rowDelta: asNumber(value.rowDelta) ?? 0,
    sizeDeltaBytes: asNumber(value.sizeDeltaBytes) ?? 0,
    schemaChanged: schemaDiff.hasChanges === true,
  };
}

/**
 * Turn one `report.json` payload into a stable record. Exported so older or
 * hand-edited artifacts can be tested without touching the filesystem.
 */
export function normalizePreviewArtifact(
  raw: unknown,
  options: {
    dirName: string;
    updatedAt?: string | null;
    artifactPath?: string | null;
    comment?: string | null;
  },
): PreviewRecord {
  const data = isRecord(raw) ? raw : {};
  const fromDir = /^pr-(\d+)$/.exec(options.dirName);
  const branchValue = asString(data.branch);
  const source = isRecord(data.source)
    ? data.source
    : ({} as Record<string, unknown>);
  const pr =
    asInteger(data.pr) ??
    (fromDir?.[1] ? Number(fromDir[1]) : null) ??
    (branchValue ? previewNumberFromBranch(branchValue) : null);

  const branch =
    branchValue ?? (pr ? `${previewBranchPrefix()}pr-${pr}` : options.dirName);

  return {
    pr,
    branch,
    parent: asString(data.parent),
    event: asString(data.event),
    action: asString(data.action),
    status: normalizePreviewStatus(data.status),
    reason: asString(data.reason),
    repo: asString(source.repo),
    title: asString(source.title),
    url: asString(source.url),
    author: asString(source.author),
    expiresAt: asString(data.expiresAt),
    updatedAt: options.updatedAt ?? null,
    artifactPath: options.artifactPath ?? null,
    steps: normalizeSteps(data.steps),
    tests: normalizeTests(data.tests),
    report: normalizeReport(data.report),
    comment: options.comment ?? null,
    error: asString(data.error),
  };
}

/**
 * Read every preview artifact directory. Invalid JSON or missing files are
 * skipped; the dashboard still renders whatever is readable.
 */
export async function loadPreviewArtifacts(
  root: string = ARTIFACTS_DIR,
): Promise<PreviewRecord[]> {
  const dir = root.replace(/\\/g, "/").replace(/\/+$/, "");

  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const records: PreviewRecord[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const reportPath = `${dir}/${entry.name}/report.json`;
    let text: string;
    try {
      text = await readFile(reportPath, "utf8");
    } catch {
      continue;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      continue;
    }

    let updatedAt: string | null = null;
    try {
      updatedAt = (await stat(reportPath)).mtime.toISOString();
    } catch {
      // Keep null; ordering falls back to the PR number.
    }

    let comment: string | null = null;
    try {
      comment = await readFile(`${dir}/${entry.name}/comment.md`, "utf8");
    } catch {
      // Older artifacts may not have a comment; that is fine.
    }

    records.push(
      normalizePreviewArtifact(raw, {
        dirName: entry.name,
        updatedAt,
        artifactPath: reportPath,
        comment,
      }),
    );
  }

  return records;
}

function liveFromBranch(branch: NeonBranch | null): PreviewLiveBranch {
  if (!branch) {
    return {
      exists: false,
      state: null,
      logicalSize: null,
      writtenDataBytes: null,
      createdAt: null,
      expiresAt: null,
      parentName: null,
    };
  }

  return {
    exists: true,
    state: branch.currentState,
    logicalSize: branch.logicalSize > 0 ? branch.logicalSize : null,
    writtenDataBytes: branch.writtenDataBytes,
    createdAt: branch.createdAt,
    expiresAt: branch.expiresAt ?? null,
    parentName: branch.parentName ?? null,
  };
}

function mostRecentFirst(a: PreviewRecord, b: PreviewRecord): number {
  const left = a.updatedAt ?? "";
  const right = b.updatedAt ?? "";
  if (left !== right) return right.localeCompare(left);
  return (b.pr ?? 0) - (a.pr ?? 0);
}

/**
 * Join artifact records with the live branch list. Preview branches that exist
 * in Neon but have no local artifact are still shown (`branch-only`) so the
 * dashboard never hides an orphaned branch.
 */
export function mergePreviews(
  records: PreviewRecord[],
  branches: NeonBranch[] | null,
): PreviewView[] {
  const byName = new Map((branches ?? []).map((branch) => [branch.name, branch]));
  const seen = new Set(records.map((record) => record.branch));

  // Keep one record per branch (newest wins) in case artifacts were copied.
  const unique = new Map<string, PreviewRecord>();
  for (const record of records) {
    const existing = unique.get(record.branch);
    if (!existing || mostRecentFirst(record, existing) < 0) {
      unique.set(record.branch, record);
    }
  }

  const views: PreviewView[] = [...unique.values()].map((record) => ({
    ...record,
    live: liveFromBranch(byName.get(record.branch) ?? null),
  }));

  for (const branch of branches ?? []) {
    if (!branch.name.startsWith(previewBranchPrefix())) continue;
    if (seen.has(branch.name)) continue;

    views.push({
      pr: previewNumberFromBranch(branch.name),
      branch: branch.name,
      parent: branch.parentName ?? null,
      event: null,
      action: null,
      status: "branch-only",
      reason: "preview branch exists but no local run artifact was found",
      repo: null,
      title: null,
      url: null,
      author: null,
      expiresAt: branch.expiresAt ?? null,
      updatedAt: null,
      artifactPath: null,
      steps: [],
      tests: null,
      report: null,
      comment: null,
      error: null,
      live: liveFromBranch(branch),
    });
  }

  return views.sort(mostRecentFirst);
}
