import type { SubjectPreviewConfig } from "../ci/preview.ts";
import {
  loadRepoRegistry,
  readEnvFile,
  requireSubjectRepo,
  resolveSubjectNeonContext,
  type RepoRegistry,
} from "../preview/registry.ts";
import { parseRepos } from "./client.ts";
import {
  emptyMonitorState,
  failedSyncSummary,
  loadMonitorState,
  saveMonitorState,
  syncRepository,
  type MonitorState,
  type SyncSummary,
  type TrackedPullRequest,
} from "./monitor.ts";

export interface WatchConfig {
  repos: string[];
  pollMs: number;
  watchOnStart: boolean;
  parent?: string;
  runTests: boolean;
  retryMs?: number;
  statePath?: string;
  /** Override the committed preview registry (tests / alternate installs). */
  registryPath?: string;
  /** Override the gitignored local registry. */
  localRegistryPath?: string;
}

export interface WatchPullRequest extends TrackedPullRequest {
  repo: string;
}

export interface WatchStatus {
  configured: boolean;
  repos: string[];
  pollMs: number;
  autoPoll: boolean;
  syncing: boolean;
  lastRunAt: string | null;
  lastError: string | null;
  summaries: SyncSummary[];
  pullRequests: WatchPullRequest[];
}

export interface SyncRunResult {
  skipped: boolean;
  summaries: SyncSummary[];
  error?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parsePollMs(value: string | undefined): number {
  if (!value) return 120_000;
  const pollMs = Number(value);
  if (!Number.isFinite(pollMs) || pollMs <= 0) {
    throw new Error(
      `Invalid GITHUB_POLL_MS "${value}". Use milliseconds, for example 120000.`,
    );
  }
  // The unauthenticated REST limit is 60 requests/hour per IP. Anything under
  // 15s is almost certainly a mistake; use a token and a lower value if needed.
  return Math.max(pollMs, 15_000);
}

function parseRetryMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const retryMs = Number(value);
  if (!Number.isFinite(retryMs) || retryMs < 0) {
    throw new Error(
      `Invalid GITHUB_WATCH_RETRY_MS "${value}". Use milliseconds, for example 300000.`,
    );
  }
  return retryMs;
}

/**
 * Resolve the watcher configuration. Returns null when no repo is configured,
 * so the server can start without GitHub at all.
 *
 * GITHUB_REPO or GITHUB_REPOS (comma-separated), GITHUB_POLL_MS,
 * GITHUB_WATCH_ON_START, GITHUB_WATCH_TESTS, GITHUB_TOKEN.
 */
export function resolveWatchConfig(
  env: NodeJS.ProcessEnv = process.env,
): WatchConfig | null {
  const repos = parseRepos(env.GITHUB_REPOS ?? env.GITHUB_REPO);
  if (repos.length === 0) return null;

  return {
    repos,
    pollMs: parsePollMs(env.GITHUB_POLL_MS),
    watchOnStart: env.GITHUB_WATCH_ON_START !== "false",
    parent: env.NEON_PARENT_BRANCH || env.GITHUB_WATCH_PARENT || undefined,
    runTests: env.GITHUB_WATCH_TESTS !== "false",
    retryMs: parseRetryMs(env.GITHUB_WATCH_RETRY_MS),
    statePath: env.GITHUB_WATCH_STATE || undefined,
    registryPath: env.AIKYA_REPO_REGISTRY || undefined,
    localRegistryPath: env.AIKYA_LOCAL_REPO_REGISTRY || undefined,
  };
}

/**
 * Polls one or more repositories and reconciles preview branches.
 *
 * A single instance is shared by the HTTP server (automatic polling plus the
 * manual "Sync PRs now" button) and the CLI. A simple in-process lock prevents
 * a manual sync from overlapping with a scheduled one.
 */
export class WatchService {
  private state: MonitorState = emptyMonitorState();
  private registry: RepoRegistry = { repos: new Map(), warnings: [] };
  private timer: ReturnType<typeof setInterval> | null = null;
  private syncing = false;
  private lastRunAt: string | null = null;
  private lastError: string | null = null;
  private summaries: SyncSummary[] = [];
  private initialized = false;

  constructor(readonly config: WatchConfig) {}

  async init(): Promise<void> {
    if (this.initialized) return;
    this.state = await loadMonitorState(this.config.statePath);
    this.registry = await loadRepoRegistry({
      path: this.config.registryPath,
      localPath: this.config.localRegistryPath,
    });
    for (const warning of this.registry.warnings) {
      console.warn(`[watch] registry: ${warning}`);
    }
    this.initialized = true;

    for (const repo of this.config.repos) {
      const lastSyncAt = this.state.repos[repo]?.lastSyncAt;
      if (lastSyncAt && (!this.lastRunAt || lastSyncAt > this.lastRunAt)) {
        this.lastRunAt = lastSyncAt;
      }
    }
  }

  /**
   * Resolve one watched repo's own project, key, checkout, and env. A missing
   * registry entry or key throws; the caller records the failure instead of
   * falling back to Aikya's project.
   */
  private async subjectFor(repo: string): Promise<SubjectPreviewConfig> {
    const entry = requireSubjectRepo(this.registry, repo);
    const neon = resolveSubjectNeonContext(entry);
    const vercel =
      entry.backend === "vercel"
        ? {
            vcpus: entry.vcpus,
            region: entry.region,
            image: entry.image,
            networkPolicy: entry.networkPolicy,
            sandboxTimeoutMs: entry.sandboxTimeoutMs,
          }
        : undefined;

    return {
      repo: entry.repo,
      neon,
      source: entry.source,
      parent: entry.parent,
      env: entry.envFrom ? await readEnvFile(entry.envFrom) : undefined,
      steps: entry.steps,
      stepTimeoutMs: entry.stepTimeoutMs,
      backend: entry.backend,
      vercel,
      review: entry.review,
    };
  }

  async start(): Promise<void> {
    await this.init();
    if (this.config.watchOnStart) {
      await this.syncNow("startup");
    }
    this.timer = setInterval(() => {
      void this.syncNow("poll");
    }, this.config.pollMs);
    console.log(
      `[watch] polling ${this.config.repos.join(", ")} every ${Math.round(this.config.pollMs / 1000)}s`,
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async syncNow(reason = "manual"): Promise<SyncRunResult> {
    if (this.syncing) {
      return { skipped: true, summaries: this.summaries };
    }

    this.syncing = true;
    try {
      await this.init();
      const summaries: SyncSummary[] = [];

      for (const repo of this.config.repos) {
        let subject: SubjectPreviewConfig;
        try {
          subject = await this.subjectFor(repo);
        } catch (error) {
          const message = errorMessage(error);
          const repoState = (this.state.repos[repo] ??= {
            lastSyncAt: null,
            lastError: null,
            pullRequests: {},
          });
          repoState.lastError = message;
          repoState.lastSyncAt = new Date().toISOString();
          summaries.push(failedSyncSummary(repo, message));
          console.error(`[watch] ${repo} configuration error: ${message}`);
          await saveMonitorState(this.state, this.config.statePath);
          continue;
        }

        const summary = await syncRepository({
          repo,
          state: this.state,
          parent: this.config.parent,
          runTests: this.config.runTests,
          subject,
          retryMs: this.config.retryMs,
          log: (line) => console.log(`[watch] ${repo} ${line}`),
        });
        summaries.push(summary);
        // Persist after each repo so a crash or timeout does not lose progress.
        await saveMonitorState(this.state, this.config.statePath);
      }

      this.summaries = summaries;
      this.lastRunAt = new Date().toISOString();
      this.lastError =
        summaries
          .filter((summary) => summary.error)
          .map((summary) => `${summary.repo}: ${summary.error}`)
          .join("; ") || null;

      const detail = summaries
        .map(
          (summary) =>
            `${summary.repo} +${summary.created} ~${summary.recreated} ` +
            `-${summary.deleted} =${summary.unchanged} !${summary.failed}`,
        )
        .join(", ");
      console.log(`[watch] ${reason}: ${detail || "no repositories"}`);

      return { skipped: false, summaries };
    } catch (error) {
      this.lastError = errorMessage(error);
      console.error(`[watch] ${reason} failed: ${this.lastError}`);
      return { skipped: false, summaries: this.summaries, error: this.lastError };
    } finally {
      this.syncing = false;
    }
  }

  /**
   * A dashboard deletion removes the branch outside the reconciliation loop.
   * Mark any tracked PR as `deleted` so the next poll recreates the branch
   * instead of treating its stale `ready` state as up to date.
   *
   * Returns true when a tracked branch was affected.
   */
  async markBranchDeleted(branch: string): Promise<boolean> {
    await this.init();
    let changed = false;

    for (const repoState of Object.values(this.state.repos)) {
      for (const tracked of Object.values(repoState.pullRequests)) {
        if (tracked.branch !== branch) continue;
        if (tracked.status === "deleted" || tracked.status === "absent") continue;
        tracked.status = "deleted";
        tracked.error = null;
        changed = true;
      }
    }

    if (changed) {
      await saveMonitorState(this.state, this.config.statePath);
    }
    return changed;
  }

  status(): WatchStatus {
    const pullRequests: WatchPullRequest[] = [];
    for (const repo of this.config.repos) {
      const repoState = this.state.repos[repo];
      if (!repoState) continue;
      for (const tracked of Object.values(repoState.pullRequests)) {
        pullRequests.push({ repo, ...tracked });
      }
    }

    pullRequests.sort((left, right) => {
      if (left.repo !== right.repo) return left.repo.localeCompare(right.repo);
      return right.number - left.number;
    });

    return {
      configured: true,
      repos: this.config.repos,
      pollMs: this.config.pollMs,
      autoPoll: this.timer !== null,
      syncing: this.syncing,
      lastRunAt: this.lastRunAt,
      lastError: this.lastError,
      summaries: this.summaries,
      pullRequests,
    };
  }
}

export function unconfiguredWatchStatus(): WatchStatus {
  return {
    configured: false,
    repos: [],
    pollMs: 0,
    autoPoll: false,
    syncing: false,
    lastRunAt: null,
    lastError: null,
    summaries: [],
    pullRequests: [],
  };
}
