import type { NeonBranch } from "./branches.ts";

export type PruneReason = "age" | "expired";

export interface PruneCandidate {
  branch: NeonBranch;
  ageMs: number;
  reason: PruneReason;
}

export interface SelectPrunableOptions {
  /** Minimum age before a branch is eligible. */
  olderThanMs: number;
  /** Only consider branches whose name starts with this prefix. */
  prefix?: string;
  /** Never prune the parent branch. */
  parentName: string;
  /** Injectable clock for tests. */
  now?: number;
}

/**
 * Select branches eligible for retention cleanup. Pure function so the policy
 * can be tested without touching Neon.
 *
 * Safety rules: never select main, the default/primary branch, a protected
 * branch, or the configured parent. An expired branch is eligible even if it is
 * younger than the age threshold.
 */
export function selectPrunable(
  branches: NeonBranch[],
  options: SelectPrunableOptions,
): PruneCandidate[] {
  const now = options.now ?? Date.now();

  return branches
    .filter((branch) => !branch.default && !branch.primary && !branch.protected)
    .filter((branch) => branch.name !== "main" && branch.name !== options.parentName)
    .filter(
      (branch) => !options.prefix || branch.name.startsWith(options.prefix),
    )
    .flatMap((branch) => {
      const createdAt = Date.parse(branch.createdAt);
      const ageMs = Number.isNaN(createdAt) ? 0 : Math.max(0, now - createdAt);
      const expiresAt = branch.expiresAt ? Date.parse(branch.expiresAt) : NaN;
      const expired = !Number.isNaN(expiresAt) && expiresAt <= now;
      const old = ageMs >= options.olderThanMs;

      if (!expired && !old) return [];
      return [
        {
          branch,
          ageMs,
          reason: expired ? ("expired" as const) : ("age" as const),
        },
      ];
    })
    .sort((a, b) => b.ageMs - a.ageMs);
}
