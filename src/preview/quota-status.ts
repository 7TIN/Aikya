import { createEventLog } from "../events/log.ts";
import { listBranches } from "../neon/branches.ts";
import { evaluateQuota, type QuotaDecision } from "./quota.ts";
import {
  loadRepoRegistry,
  resolveSubjectNeonContext,
  type RepoRegistry,
} from "./registry.ts";

/**
 * Read-only quota status for every registered repository. Used by the CLI and
 * the dashboard; it never creates or deletes anything.
 */
export interface RepoQuotaStatus {
  repo: string;
  projectId: string;
  decision: QuotaDecision | null;
  error: string | null;
}

export interface QuotaStatusReport {
  repos: RepoQuotaStatus[];
  warnings: string[];
  generatedAt: string;
}

export async function collectQuotaStatuses(options: {
  registry?: RepoRegistry;
  repo?: string;
  now?: number;
} = {}): Promise<QuotaStatusReport> {
  const registry = options.registry ?? (await loadRepoRegistry());
  const now = options.now ?? Date.now();
  const events = createEventLog();

  const entries = [...registry.repos.values()]
    .filter((entry) =>
      options.repo
        ? entry.repo.toLowerCase() === options.repo.toLowerCase()
        : true,
    )
    .sort((left, right) => left.repo.localeCompare(right.repo));

  const repos: RepoQuotaStatus[] = [];

  for (const entry of entries) {
    try {
      const neon = resolveSubjectNeonContext(entry);
      const [branches, repoEvents] = await Promise.all([
        listBranches(neon),
        events.load({ repo: entry.repo, limit: 2_000 }),
      ]);

      repos.push({
        repo: entry.repo,
        projectId: entry.projectId,
        decision: evaluateQuota({
          repo: entry.repo,
          branches,
          events: repoEvents,
          limits: entry.quota,
          now,
        }),
        error: null,
      });
    } catch (error) {
      repos.push({
        repo: entry.repo,
        projectId: entry.projectId,
        decision: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    repos,
    warnings: registry.warnings,
    generatedAt: new Date(now).toISOString(),
  };
}
