import type { NeonBranch } from "../neon/branches.ts";
import type { AikyaEvent } from "../events/log.ts";

/**
 * W4: cost view.
 *
 * Neon does not expose a per-branch invoice, so this is an **estimate** built
 * from the branch metadata the CLI already returns:
 *
 *   storage  = billed branch storage (child delta capped at logical size,
 *              root branches at full logical size)
 *   compute  = Neon `cpu_used_sec` converted to CU-hours
 *   sandbox  = reviewer durations from the event log
 *
 * Rates are configurable because Neon pricing varies by region and plan. The
 * dashboard and API label every number as an estimate.
 */

export interface CostRates {
  /** USD per GB-hour of branch storage. */
  storagePerGbHourUsd: number;
  /** USD per CU-hour of compute. */
  computePerCuHourUsd: number;
  /** USD per hour of Vercel Sandbox reviewer time. */
  sandboxPerHourUsd: number;
}

export interface BranchCost {
  name: string;
  parentId?: string;
  parentName?: string;
  logicalSizeBytes: number;
  /** Best-effort billed storage: child delta capped at logical size. */
  estimatedStorageBytes: number;
  cpuUsedSec: number;
  computeTimeSeconds: number;
  ageHours: number;
  storageCostUsd: number;
  computeCostUsd: number;
  totalUsd: number;
}

export interface CostView {
  rates: CostRates;
  branches: BranchCost[];
  totalUsd: number;
  storageUsd: number;
  computeUsd: number;
  sandboxUsd: number;
  sandboxSeconds: number;
  generatedAt: string;
  /** True when a rate was overridden by the environment. */
  ratesFromEnv: boolean;
}

const SECOND = 1_000;
const HOUR = 3_600_000;
const GB = 1_000_000_000;

/** Conservative defaults; override with AIKYA_COST_* env vars. */
export const DEFAULT_COST_RATES: CostRates = {
  storagePerGbHourUsd: 0.000_027_8,
  computePerCuHourUsd: 0.169,
  sandboxPerHourUsd: 0.06,
};

export function costRatesFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): { rates: CostRates; fromEnv: boolean } {
  let fromEnv = false;
  const rates: CostRates = { ...DEFAULT_COST_RATES };

  const storage = Number(env.AIKYA_COST_STORAGE_PER_GB_HOUR_USD);
  if (Number.isFinite(storage) && storage >= 0) {
    rates.storagePerGbHourUsd = storage;
    fromEnv = true;
  }

  const compute = Number(env.AIKYA_COST_COMPUTE_PER_CU_HOUR_USD);
  if (Number.isFinite(compute) && compute >= 0) {
    rates.computePerCuHourUsd = compute;
    fromEnv = true;
  }

  const sandbox = Number(env.AIKYA_COST_SANDBOX_PER_HOUR_USD);
  if (Number.isFinite(sandbox) && sandbox >= 0) {
    rates.sandboxPerHourUsd = sandbox;
    fromEnv = true;
  }

  return { rates, fromEnv };
}

function estimatedStorageBytes(branch: NeonBranch, parent?: NeonBranch): number {
  if (branch.parentId && parent && parent.logicalSize > 0 && branch.logicalSize > 0) {
    return Math.max(0, Math.min(branch.logicalSize, Math.abs(branch.logicalSize - parent.logicalSize)));
  }
  // Root branches are billed on the full logical size.
  return branch.logicalSize;
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function computeBranchCosts(
  branches: NeonBranch[],
  rates: CostRates,
  now: number = Date.now(),
): BranchCost[] {
  const byId = new Map(branches.map((branch) => [branch.id, branch]));

  return branches.map((branch) => {
    const parent = branch.parentId ? byId.get(branch.parentId) : undefined;
    const estimatedStorage = estimatedStorageBytes(branch, parent);
    const ageHours = Math.max(0, (now - Date.parse(branch.createdAt)) / HOUR);

    const storageCost = (estimatedStorage / GB) * ageHours * rates.storagePerGbHourUsd;
    const computeCost = (branch.cpuUsedSec / 3_600) * rates.computePerCuHourUsd;

    return {
      name: branch.name,
      parentId: branch.parentId,
      parentName: branch.parentName,
      logicalSizeBytes: branch.logicalSize,
      estimatedStorageBytes: estimatedStorage,
      cpuUsedSec: branch.cpuUsedSec,
      computeTimeSeconds: branch.computeTimeSeconds,
      ageHours,
      storageCostUsd: roundUsd(storageCost),
      computeCostUsd: roundUsd(computeCost),
      totalUsd: roundUsd(storageCost + computeCost),
    };
  });
}

export function computeSandboxCost(
  events: AikyaEvent[],
  rates: CostRates,
): { sandboxUsd: number; sandboxSeconds: number } {
  let sandboxMs = 0;

  for (const event of events) {
    if (event.type !== "review.completed" || event.status !== "ok") continue;
    if (typeof event.durationMs === "number" && event.durationMs > 0) {
      sandboxMs += event.durationMs;
    }
  }

  const sandboxSeconds = sandboxMs / SECOND;
  return {
    sandboxUsd: roundUsd((sandboxSeconds / 3_600) * rates.sandboxPerHourUsd),
    sandboxSeconds,
  };
}

export function buildCostView(input: {
  branches: NeonBranch[];
  events: AikyaEvent[];
  rates?: CostRates;
  ratesFromEnv?: boolean;
  now?: number;
}): CostView {
  const rates = input.rates ?? DEFAULT_COST_RATES;
  const now = input.now ?? Date.now();
  const branches = computeBranchCosts(input.branches, rates, now);
  const sandbox = computeSandboxCost(input.events, rates);

  const storageUsd = roundUsd(branches.reduce((sum, branch) => sum + branch.storageCostUsd, 0));
  const computeUsd = roundUsd(branches.reduce((sum, branch) => sum + branch.computeCostUsd, 0));

  return {
    rates,
    branches,
    totalUsd: roundUsd(storageUsd + computeUsd + sandbox.sandboxUsd),
    storageUsd,
    computeUsd,
    sandboxUsd: sandbox.sandboxUsd,
    sandboxSeconds: sandbox.sandboxSeconds,
    generatedAt: new Date(now).toISOString(),
    ratesFromEnv: input.ratesFromEnv ?? false,
  };
}
