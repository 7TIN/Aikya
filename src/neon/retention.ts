import type { NeonBranch } from "./branches.ts";

/**
 * W4 retention warnings.
 *
 * Informational only: nothing here deletes a branch. The dashboard surfaces
 * the warnings next to the inventory, and the reaper uses its own selection
 * rules (`neon/prune.ts`).
 */

export type RetentionWarningCode = "expired" | "stale" | "missing-owner";

/** Default age at which an unexpired branch is called stale. */
export const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1_000;

export interface RetentionWarning {
  code: RetentionWarningCode;
  branch: string;
  message: string;
  ageMs: number;
}

export interface BranchWarningsOptions {
  /** Minimum age before an unexpired preview branch is called stale. */
  staleAfterMs: number;
  /** Branches tracked by the watcher. When omitted, missing-owner warnings are
   * disabled (for example when the watcher is not configured). */
  ownedBranches?: Set<string>;
  /** Long-lived environment branches that never produce warnings. */
  protectedNames?: string[];
  /** Injectable clock for tests. */
  now?: number;
}

/**
 * Repo-scoped preview branches look like `preview/owner-repo-pr-3`.
 * Aikya's own `preview/pr-3` has no repository segment and is not managed by
 * the watcher, so it never produces a missing-owner warning.
 */
export function isManagedPreviewBranch(name: string): boolean {
  return /^preview\/[a-z0-9-]+-pr-\d+$/.test(name);
}

export function branchWarnings(
  branches: NeonBranch[],
  options: BranchWarningsOptions,
): RetentionWarning[] {
  const now = options.now ?? Date.now();
  const warnings: RetentionWarning[] = [];

  for (const branch of branches) {
    if (branch.default || branch.primary || branch.protected) continue;
    if (branch.name === "main") continue;
    if (options.protectedNames?.includes(branch.name)) continue;

    const createdAt = Date.parse(branch.createdAt);
    const ageMs = Number.isNaN(createdAt) ? 0 : Math.max(0, now - createdAt);
    const expiresAt = branch.expiresAt ? Date.parse(branch.expiresAt) : NaN;

    if (!Number.isNaN(expiresAt) && expiresAt <= now) {
      warnings.push({
        code: "expired",
        branch: branch.name,
        ageMs,
        message: `expired ${relative(now - expiresAt)} ago`,
      });
    } else if (ageMs >= options.staleAfterMs) {
      warnings.push({
        code: "stale",
        branch: branch.name,
        ageMs,
        message: `${relative(ageMs)} old; no TTL elapsed yet`,
      });
    }

    if (
      options.ownedBranches &&
      isManagedPreviewBranch(branch.name) &&
      !options.ownedBranches.has(branch.name)
    ) {
      warnings.push({
        code: "missing-owner",
        branch: branch.name,
        ageMs,
        message: "no open tracked PR owns this preview branch",
      });
    }
  }

  return warnings;
}

/** Group warnings by branch for the inventory table. */
export function warningsByBranch(
  warnings: RetentionWarning[],
): Map<string, RetentionWarning[]> {
  const grouped = new Map<string, RetentionWarning[]>();
  for (const warning of warnings) {
    const list = grouped.get(warning.branch) ?? [];
    list.push(warning);
    grouped.set(warning.branch, list);
  }
  return grouped;
}

function relative(ms: number): string {
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1_000))}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  return `${(ms / 86_400_000).toFixed(1)}d`;
}
