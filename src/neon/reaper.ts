import { createEventLog, type EventLog } from "../events/log.ts";
import { deleteBranch, listBranches, type NeonBranch } from "./branches.ts";
import type { NeonContext } from "./cli.ts";
import { selectPrunable, type PruneReason } from "./prune.ts";
import { STALE_AFTER_MS } from "./retention.ts";

/**
 * W4 TTL reaper.
 *
 * Deletes only branches selected by the same guarded policy as `branch:prune`
 * (never main, the parent, a default/primary/Neon-protected branch, or a
 * persistent environment), restricted to the `preview/` prefix by default.
 * Dry-run is the default; every run appends a `reap.completed` event.
 */
export interface ReaperOptions {
  context?: NeonContext;
  /** Registry repo name, recorded in events when reaping a subject project. */
  repo?: string;
  /** Branch prefix; defaults to `preview/` so ad-hoc branches are out of scope. */
  prefix?: string;
  /** Minimum age before an unexpired branch is eligible. Defaults to 7 days. */
  olderThanMs?: number;
  parentName: string;
  protectedNames?: string[];
  /** Delete for real. Defaults to true (dry run) — pass `false` to delete. */
  dryRun?: boolean;
  now?: number;
  deps?: {
    list?: (context?: NeonContext) => Promise<NeonBranch[]>;
    delete?: (name: string, context?: NeonContext) => Promise<unknown>;
    events?: EventLog;
  };
}

export interface ReaperCandidate {
  name: string;
  createdAt: string;
  expiresAt: string | null;
  ageMs: number;
  reason: PruneReason;
}

export interface ReaperReport {
  repo: string | null;
  startedAt: string;
  finishedAt: string;
  mode: "dry-run" | "delete";
  prefix: string;
  olderThanMs: number;
  parent: string;
  candidates: ReaperCandidate[];
  deleted: string[];
  failed: Array<{ branch: string; error: string }>;
  durationMs: number;
}

export async function runReaper(options: ReaperOptions): Promise<ReaperReport> {
  const startedAtMs = options.now ?? Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const dryRun = options.dryRun ?? true;
  const prefix = options.prefix ?? "preview/";
  const olderThanMs = options.olderThanMs ?? STALE_AFTER_MS;
  const list = options.deps?.list ?? listBranches;
  const remove = options.deps?.delete ?? deleteBranch;
  const events = options.deps?.events ?? createEventLog();

  const branches = await list(options.context);
  const selected = selectPrunable(branches, {
    olderThanMs,
    prefix,
    parentName: options.parentName,
    protectedNames: options.protectedNames,
    now: startedAtMs,
  });

  const candidates: ReaperCandidate[] = selected.map((candidate) => ({
    name: candidate.branch.name,
    createdAt: candidate.branch.createdAt,
    expiresAt: candidate.branch.expiresAt ?? null,
    ageMs: candidate.ageMs,
    reason: candidate.reason,
  }));

  const deleted: string[] = [];
  const failed: Array<{ branch: string; error: string }> = [];

  if (!dryRun) {
    for (const candidate of candidates) {
      try {
        await remove(candidate.name, options.context);
        deleted.push(candidate.name);
        await events.append({
          type: "branch.deleted",
          repo: options.repo,
          branch: candidate.name,
          status: "deleted",
          reason: `reaper:${candidate.reason}`,
          detail: {
            reason: candidate.reason,
            ageMs: candidate.ageMs,
            expiresAt: candidate.expiresAt,
            source: "reaper",
          },
        });
      } catch (error) {
        failed.push({
          branch: candidate.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  const finishedAtMs = Date.now();
  const report: ReaperReport = {
    repo: options.repo ?? null,
    startedAt,
    finishedAt: new Date(finishedAtMs).toISOString(),
    mode: dryRun ? "dry-run" : "delete",
    prefix,
    olderThanMs,
    parent: options.parentName,
    candidates,
    deleted,
    failed,
    durationMs: Math.max(0, finishedAtMs - startedAtMs),
  };

  await events.append({
    type: "reap.completed",
    repo: options.repo,
    status:
      failed.length > 0 ? "failed" : dryRun ? "dry-run" : "ok",
    durationMs: report.durationMs,
    reason: failed.length > 0 ? `${failed.length} branch(es) failed` : undefined,
    detail: {
      mode: report.mode,
      prefix: report.prefix,
      olderThanMs: report.olderThanMs,
      candidates: candidates.map((candidate) => candidate.name),
      deleted,
      failed: failed.map((entry) => entry.branch),
    },
  });

  return report;
}
