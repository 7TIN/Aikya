import type { AikyaEvent } from "../events/log.ts";
import type { NeonBranch } from "../neon/branches.ts";
import { isPreviewBranchFor } from "../lib/repo.ts";

/**
 * W4 guardrail: per-repository quotas.
 *
 * A quota is evaluated **before** a watched repo's branch is created or
 * replaced, so an over-quota request is refused without touching the branch
 * that is already live. The refusal carries the exact limit in its message and
 * appends a `quota.exceeded` event.
 *
 * Usage is derived from data Aikya already has:
 *
 *   branches        → current preview branches for the repo
 *   storage delta   → newest `branch.report` per live branch
 *   sandbox minutes → `sync.finished` durations in the last 24h
 *   creates/hour    → `branch.created` events in the last hour
 *
 * Limits can be set per repo (`quota` in the registry) or globally in the
 * environment. Registry values win; environment values act as the default for
 * every repo that does not override them.
 */
export interface QuotaLimits {
  /** Concurrent preview branches this repo may have. */
  maxBranches: number;
  /** Sum of positive branch storage deltas, in bytes. */
  maxStorageDeltaBytes: number;
  /** Sandbox/reviewer minutes per rolling 24 hours. */
  maxSandboxMinutesPerDay: number;  /** Branch creations (including recreations) per rolling hour. */
  maxCreatesPerHour: number;
}

export interface QuotaUsage {
  branches: number;
  storageDeltaBytes: number;
  sandboxSeconds: number;
  createsLastHour: number;
}

export type QuotaCode = keyof QuotaLimits;

export interface QuotaViolation {
  code: QuotaCode;
  limit: number;
  used: number;
  message: string;
}

export interface QuotaDecision {
  allowed: boolean;
  repo: string;
  limits: QuotaLimits;
  usage: QuotaUsage;
  violations: QuotaViolation[];
  /** Human-readable summary of every violation, or null when allowed. */
  message: string | null;
  checkedAt: string;
}

export const DEFAULT_QUOTA_LIMITS: QuotaLimits = {
  maxBranches: 10,
  maxStorageDeltaBytes: 512 * 1024 * 1024,
  maxSandboxMinutesPerDay: 30,
  maxCreatesPerHour: 20,
};

const DAY_MS = 24 * 60 * 60 * 1_000;
const HOUR_MS = 60 * 60 * 1_000;

export class QuotaExceededError extends Error {
  constructor(
    readonly repo: string,
    readonly decision: QuotaDecision,
  ) {
    super(decision.message ?? `Quota exceeded for ${repo}.`);
    this.name = "QuotaExceededError";
  }
}

function positive(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number <= 0) return undefined;
  return number;
}

/** Read the global defaults from `AIKYA_QUOTA_*`; invalid values are ignored. */
export function quotaLimitsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Partial<QuotaLimits> {
  const limits: Partial<QuotaLimits> = {};

  const branches = positive(env.AIKYA_QUOTA_MAX_BRANCHES);
  if (branches !== undefined) limits.maxBranches = Math.floor(branches);

  const storageMb = positive(env.AIKYA_QUOTA_MAX_STORAGE_DELTA_MB);
  if (storageMb !== undefined) {
    limits.maxStorageDeltaBytes = Math.floor(storageMb * 1024 * 1024);
  }

  const sandboxMinutes = positive(env.AIKYA_QUOTA_MAX_SANDBOX_MINUTES_PER_DAY);
  if (sandboxMinutes !== undefined) {
    limits.maxSandboxMinutesPerDay = sandboxMinutes;
  }

  const creates = positive(env.AIKYA_QUOTA_MAX_CREATES_PER_HOUR);
  if (creates !== undefined) limits.maxCreatesPerHour = Math.floor(creates);

  return limits;
}

/**
 * Effective limits: defaults ← env ← registry entry. A `null` field means
 * "use the inherited value".
 */
export function resolveQuotaLimits(
  overrides?: Partial<QuotaLimits> | null,
  env: NodeJS.ProcessEnv = process.env,
): QuotaLimits {
  return {
    ...DEFAULT_QUOTA_LIMITS,
    ...quotaLimitsFromEnv(env),
    ...(overrides ?? {}),
  };
}

function latestReports(
  events: AikyaEvent[],
  liveBranches: Set<string>,
): Map<string, number> {
  const latest = new Map<string, number>();

  // `load()` returns newest first, so the first report per branch wins.
  for (const event of events) {
    if (event.type !== "branch.report") continue;
    if (!event.branch || !liveBranches.has(event.branch)) continue;
    if (latest.has(event.branch)) continue;

    const delta = event.detail?.sizeDeltaBytes;
    if (typeof delta === "number" && Number.isFinite(delta)) {
      latest.set(event.branch, Math.max(0, delta));
    }
  }

  return latest;
}

export function computeQuotaUsage(input: {
  repo: string;
  branches: NeonBranch[];
  events: AikyaEvent[];
  now?: number;
}): QuotaUsage {
  const now = input.now ?? Date.now();
  const live = input.branches.filter((branch) =>
    isPreviewBranchFor(input.repo, branch.name),
  );
  const liveNames = new Set(live.map((branch) => branch.name));

  const reports = latestReports(input.events, liveNames);
  let storageDeltaBytes = 0;
  for (const delta of reports.values()) storageDeltaBytes += delta;

  let sandboxMs = 0;
  let createsLastHour = 0;

  for (const event of input.events) {
    if (event.repo !== input.repo) continue;
    const at = Date.parse(event.at);
    if (!Number.isFinite(at)) continue;

    if (
      event.type === "sync.finished" &&
      typeof event.durationMs === "number" &&
      at >= now - DAY_MS
    ) {
      sandboxMs += Math.max(0, event.durationMs);
    }

    if (event.type === "branch.created" && at >= now - HOUR_MS) {
      createsLastHour += 1;
    }
  }

  return {
    branches: live.length,
    storageDeltaBytes,
    sandboxSeconds: sandboxMs / 1_000,
    createsLastHour,
  };
}

function violation(
  code: QuotaCode,
  limit: number,
  used: number,
  detail: string,
): QuotaViolation {
  return {
    code,
    limit,
    used,
    message: `${detail} (limit ${formatLimit(code, limit)}; used ${formatLimit(code, used)})`,
  };
}

function formatLimit(code: QuotaCode, value: number): string {
  if (code === "maxStorageDeltaBytes") {
    const mb = value / (1024 * 1024);
    return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GiB` : `${mb.toFixed(1)} MiB`;
  }
  if (code === "maxSandboxMinutesPerDay") {
    // Sandbox usage is stored in seconds; display minutes.
    const minutes = value / 60;
    return `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)} min`;
  }
  if (code === "maxCreatesPerHour") return `${value}/hour`;
  if (code === "maxBranches") return `${value} branch${value === 1 ? "" : "es"}`;
  return String(value);
}

export function evaluateQuota(input: {
  repo: string;
  branches: NeonBranch[];
  events: AikyaEvent[];
  limits?: Partial<QuotaLimits> | null;
  /** True when the run would add a branch (create/reopen, not replace). */
  addBranch?: boolean;
  now?: number;
}): QuotaDecision {
  const now = input.now ?? Date.now();
  const limits = resolveQuotaLimits(input.limits);
  const usage = computeQuotaUsage({
    repo: input.repo,
    branches: input.branches,
    events: input.events,
    now,
  });

  const projectedBranches = usage.branches + (input.addBranch ? 1 : 0);
  const violations: QuotaViolation[] = [];

  if (projectedBranches > limits.maxBranches) {
    violations.push(
      violation(
        "maxBranches",
        limits.maxBranches,
        projectedBranches,
        `${projectedBranches} preview branch${projectedBranches === 1 ? "" : "es"} for ${input.repo}`,
      ),
    );
  }

  if (usage.storageDeltaBytes > limits.maxStorageDeltaBytes) {
    violations.push(
      violation(
        "maxStorageDeltaBytes",
        limits.maxStorageDeltaBytes,
        usage.storageDeltaBytes,
        `preview storage delta for ${input.repo}`,
      ),
    );
  }

  if (usage.sandboxSeconds > limits.maxSandboxMinutesPerDay * 60) {
    violations.push(
      violation(
        "maxSandboxMinutesPerDay",
        limits.maxSandboxMinutesPerDay * 60,
        usage.sandboxSeconds,
        `sandbox time in the last 24h for ${input.repo}`,
      ),
    );
  }


  if (usage.createsLastHour + 1 > limits.maxCreatesPerHour) {
    violations.push(
      violation(
        "maxCreatesPerHour",
        limits.maxCreatesPerHour,
        usage.createsLastHour + 1,
        `branch creations in the last hour for ${input.repo}`,
      ),
    );
  }

  return {
    allowed: violations.length === 0,
    repo: input.repo,
    limits,
    usage,
    violations,
    message:
      violations.length === 0
        ? null
        : `Quota exceeded for ${input.repo}: ${violations.map((entry) => entry.message).join("; ")}`,
    checkedAt: new Date(now).toISOString(),
  };
}

/** Throw a `QuotaExceededError` when the decision is not allowed. */
export function assertQuota(decision: QuotaDecision): void {
  if (!decision.allowed) {
    throw new QuotaExceededError(decision.repo, decision);
  }
}

/** One-line usage summary for the CLI and dashboard. */
export function formatQuotaUsage(decision: QuotaDecision): string {
  const { usage, limits } = decision;
  return (
    `${usage.branches}/${limits.maxBranches} branches · ` +
    `${usage.sandboxSeconds.toFixed(0)}s/${(limits.maxSandboxMinutesPerDay * 60).toFixed(0)}s sandbox · ` +
    `${formatLimit("maxStorageDeltaBytes", usage.storageDeltaBytes)}/${formatLimit("maxStorageDeltaBytes", limits.maxStorageDeltaBytes)} storage · ` +
    `${usage.createsLastHour}/${limits.maxCreatesPerHour} creates/h`
  );
}

/** Parse `quota` from the registry; throws with the file and repo on bad input. */
export function parseQuota(
  value: unknown,
  file: string,
  repo: string,
): Partial<QuotaLimits> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${file}: repos[${repo}].quota must be an object.`);
  }

  const raw = value as Record<string, unknown>;
  const known = new Set([
    "maxBranches",
    "maxStorageDeltaBytes",
    "maxSandboxMinutesPerDay",
    "maxCreatesPerHour",
  ]);

  for (const key of Object.keys(raw)) {
    if (!known.has(key)) {
      throw new Error(`${file}: repos[${repo}].quota has unknown key "${key}".`);
    }
  }

  const quota: Partial<QuotaLimits> = {};
  for (const key of known) {
    if (raw[key] === undefined || raw[key] === null) continue;
    const number = positive(raw[key]);
    if (number === undefined) {
      throw new Error(
        `${file}: repos[${repo}].quota.${key} must be a positive number.`,
      );
    }
    (quota as Record<string, number>)[key] = number;
  }

  return quota;
}

export function describeQuotaError(error: unknown): string | null {
  return error instanceof QuotaExceededError ? error.message : null;
}
