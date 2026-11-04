import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizeBranchName, type PreviewEvent } from "../ci/events.ts";
import {
  runPreview,
  type PreviewOptions,
  type PreviewResult,
} from "../ci/preview.ts";
import {
  listOpenPullRequests,
  parseRepo,
  type GithubPullRequest,
} from "./client.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

export type PreviewStatus = PreviewResult["status"];

export interface TrackedPullRequest {
  number: number;
  title: string;
  author: string | null;
  url: string;
  draft: boolean;
  headSha: string;
  branch: string;
  status: PreviewStatus;
  event: string | null;
  /** Last successful (or attempted) sync. */
  syncedAt: string | null;
  /** Last attempt, used for failure backoff. */
  lastAttemptAt: string | null;
  error: string | null;
}

export interface RepoWatchState {
  lastSyncAt: string | null;
  lastError: string | null;
  pullRequests: Record<string, TrackedPullRequest>;
}

export interface MonitorState {
  version: 1;
  repos: Record<string, RepoWatchState>;
}

export type SyncDecision = "create" | "recreate" | "reopen" | "skip" | "retry";

export interface Decision {
  action: SyncDecision;
  reason: string;
}

export interface SyncPullRequestOutcome {
  number: number;
  action: SyncDecision | "delete";
  status: PreviewStatus | "unknown";
  branch: string;
  headSha: string;
  error: string | null;
}

export interface SyncSummary {
  repo: string;
  startedAt: string;
  finishedAt: string;
  fetched: number;
  created: number;
  recreated: number;
  reopened: number;
  deleted: number;
  unchanged: number;
  failed: number;
  complete: boolean;
  error: string | null;
  pullRequests: SyncPullRequestOutcome[];
}

export interface SyncDependencies {
  fetchPullRequests?: (
    repo: string,
  ) => Promise<{ pullRequests: GithubPullRequest[]; complete: boolean }>;
  preview?: (options: PreviewOptions) => Promise<PreviewResult>;
  now?: () => number;
}

export interface SyncRepositoryOptions {
  repo: string;
  state: MonitorState;
  parent?: string;
  runTests?: boolean;
  /** Failed previews are retried after this many milliseconds. */
  retryMs?: number;
  /** Override the artifact directory (tests). */
  artifactsDir?: (repo: string, pr: number) => string;
  deps?: SyncDependencies;
  log?: (line: string) => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `7TIN/gh-lab` → `7tin-gh-lab`, used to namespace branches and artifacts. */
export function repoSegment(repo: string): string {
  const segment = repo
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return segment || "repo";
}

/**
 * Branch names are scoped by repository because one Neon project is shared by
 * every watched repo for now. `preview/pr-7` stays reserved for Aikya's own
 * PR workflow; watched repos use `preview/<owner>-<repo>-pr-7`.
 *
 * Neon limits branch names to 63 characters. Truncate the repository segment,
 * never the `-pr-<n>` suffix, and add a short hash when truncating so two long
 * repository names cannot collapse to the same branch.
 */
export function monitorBranchName(repo: string, pr: number): string {
  const prefix = "preview/";
  const suffix = `-pr-${pr}`;
  const maxSegment = 63 - prefix.length - suffix.length;
  const segment = repoSegment(repo);

  if (maxSegment < 1) {
    return sanitizeBranchName(`preview/pr-${pr}`);
  }

  let bounded = segment;
  if (segment.length > maxSegment) {
    const hash = shortHash(segment);
    const room = maxSegment - hash.length - 1;
    bounded =
      room >= 1
        ? `${segment.slice(0, room).replace(/-+$/g, "")}-${hash}`
        : segment.slice(0, maxSegment).replace(/-+$/g, "");
  }

  return sanitizeBranchName(`${prefix}${bounded || "repo"}${suffix}`);
}

/** Small deterministic FNV-1a hash used only to disambiguate long names. */
function shortHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).padStart(6, "0").slice(0, 6);
}

export function artifactDirFor(repo: string, pr: number): string {
  return `${ROOT.replace(/\\/g, "/").replace(/\/+$/, "")}/artifacts/preview/${repoSegment(repo)}-pr-${pr}`;
}

export function defaultStatePath(): string {
  return `${ROOT.replace(/\\/g, "/").replace(/\/+$/, "")}/artifacts/monitor/state.json`;
}

export function emptyMonitorState(): MonitorState {
  return { version: 1, repos: {} };
}

function normalizeTracked(raw: unknown): TrackedPullRequest | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.number !== "number" || typeof value.branch !== "string") {
    return null;
  }
  return {
    number: value.number,
    title: typeof value.title === "string" ? value.title : "",
    author: typeof value.author === "string" ? value.author : null,
    url: typeof value.url === "string" ? value.url : "",
    draft: value.draft === true,
    headSha: typeof value.headSha === "string" ? value.headSha : "",
    branch: value.branch,
    status:
      typeof value.status === "string"
        ? (value.status as PreviewStatus)
        : "failed",
    event: typeof value.event === "string" ? value.event : null,
    syncedAt: typeof value.syncedAt === "string" ? value.syncedAt : null,
    lastAttemptAt:
      typeof value.lastAttemptAt === "string" ? value.lastAttemptAt : null,
    error: typeof value.error === "string" ? value.error : null,
  };
}

export function normalizeMonitorState(raw: unknown): MonitorState {
  const state = emptyMonitorState();
  if (typeof raw !== "object" || raw === null) return state;
  const repos = (raw as Record<string, unknown>).repos;
  if (typeof repos !== "object" || repos === null) return state;

  for (const [repo, value] of Object.entries(repos)) {
    if (typeof value !== "object" || value === null) continue;
    const entry = value as Record<string, unknown>;
    const repoState: RepoWatchState = {
      lastSyncAt:
        typeof entry.lastSyncAt === "string" ? entry.lastSyncAt : null,
      lastError: typeof entry.lastError === "string" ? entry.lastError : null,
      pullRequests: {},
    };

    const pullRequests = entry.pullRequests;
    if (typeof pullRequests === "object" && pullRequests !== null) {
      for (const [number, tracked] of Object.entries(pullRequests)) {
        const normalized = normalizeTracked(tracked);
        if (normalized) repoState.pullRequests[number] = normalized;
      }
    }

    state.repos[repo] = repoState;
  }

  return state;
}

export async function loadMonitorState(
  path: string = defaultStatePath(),
): Promise<MonitorState> {
  try {
    const text = await readFile(path, "utf8");
    return normalizeMonitorState(JSON.parse(text) as unknown);
  } catch {
    return emptyMonitorState();
  }
}

export async function saveMonitorState(
  state: MonitorState,
  path: string = defaultStatePath(),
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

/**
 * Decide what a poll should do for one PR. Pure so the lifecycle is testable:
 * a new PR creates, a new head commit recreates, a reopened/deleted branch
 * reopens, and an unchanged ready branch is skipped.
 */
export function decideAction(
  previous: TrackedPullRequest | undefined,
  pullRequest: GithubPullRequest,
  options: { now?: number; retryMs?: number } = {},
): Decision {
  const now = options.now ?? Date.now();
  const retryMs = options.retryMs ?? 5 * 60_000;

  if (!previous) {
    return { action: "create", reason: "new pull request" };
  }

  if (previous.headSha !== pullRequest.headSha) {
    return {
      action: "recreate",
      reason: `head commit changed (${previous.headSha.slice(0, 7)} → ${pullRequest.headSha.slice(0, 7)})`,
    };
  }

  if (previous.status === "failed") {
    const attemptedAt = previous.lastAttemptAt
      ? Date.parse(previous.lastAttemptAt)
      : Number.NaN;
    if (Number.isFinite(attemptedAt) && now - attemptedAt < retryMs) {
      return {
        action: "retry",
        reason: `previous attempt failed; retrying in ${Math.ceil((retryMs - (now - attemptedAt)) / 1000)}s`,
      };
    }
  }

  if (previous.status !== "ready") {
    return {
      action: previous.status === "deleted" ? "reopen" : "create",
      reason: `branch is ${previous.status}, not ready`,
    };
  }

  return { action: "skip", reason: "branch is up to date" };
}

function eventFor(decision: SyncDecision): PreviewEvent {
  if (decision === "create") return "opened";
  if (decision === "reopen") return "reopened";
  return "synchronize";
}

function metadata(pr: GithubPullRequest) {
  return {
    title: pr.title,
    author: pr.author,
    url: pr.htmlUrl,
    draft: pr.draft,
  };
}

/**
 * One reconciliation pass for one repository:
 *
 *   open PR, unseen        → create preview branch
 *   open PR, new head SHA  → delete + recreate
 *   open PR, unchanged     → skip
 *   tracked PR no longer open → delete its branch
 *
 * Only open PRs are fetched. Deletions are skipped when pagination was
 * incomplete, so a truncated response can never delete a live branch.
 */
export async function syncRepository(
  options: SyncRepositoryOptions,
): Promise<SyncSummary> {
  const repo = parseRepo(options.repo);
  const now = options.deps?.now?.() ?? Date.now();
  const retryMs = options.retryMs ?? 5 * 60_000;
  const runTests = options.runTests ?? true;
  const parent = options.parent ?? "main";
  const log = options.log ?? (() => {});
  const fetchPullRequests =
    options.deps?.fetchPullRequests ??
    ((name: string) =>
      listOpenPullRequests(name, { token: process.env.GITHUB_TOKEN }));
  const preview = options.deps?.preview ?? runPreview;
  const artifactsDir =
    options.artifactsDir ?? ((name: string, pr: number) => artifactDirFor(name, pr));

  const repoState = (options.state.repos[repo] ??= {
    lastSyncAt: null,
    lastError: null,
    pullRequests: {},
  });

  const summary: SyncSummary = {
    repo,
    startedAt: new Date(now).toISOString(),
    finishedAt: new Date(now).toISOString(),
    fetched: 0,
    created: 0,
    recreated: 0,
    reopened: 0,
    deleted: 0,
    unchanged: 0,
    failed: 0,
    complete: false,
    error: null,
    pullRequests: [],
  };

  let fetched: Awaited<ReturnType<typeof fetchPullRequests>>;
  try {
    fetched = await fetchPullRequests(repo);
  } catch (error) {
    const message = errorMessage(error);
    repoState.lastError = message;
    repoState.lastSyncAt = new Date().toISOString();
    summary.error = message;
    summary.finishedAt = new Date().toISOString();
    return summary;
  }

  summary.fetched = fetched.pullRequests.length;
  summary.complete = fetched.complete;
  const open = new Set(fetched.pullRequests.map((pr) => String(pr.number)));

  for (const pr of fetched.pullRequests) {
    const key = String(pr.number);
    const previous = repoState.pullRequests[key];
    const decision = decideAction(previous, pr, { now, retryMs });
    const branch = monitorBranchName(repo, pr.number);

    if (decision.action === "skip" || decision.action === "retry") {
      if (previous) {
        Object.assign(previous, metadata(pr));
      }
      summary.unchanged += 1;
      summary.pullRequests.push({
        number: pr.number,
        action: decision.action,
        status: previous?.status ?? "unknown",
        branch,
        headSha: pr.headSha,
        error: previous?.error ?? null,
      });
      log(`#${pr.number} ${decision.action}: ${decision.reason}`);
      continue;
    }

    const event = eventFor(decision.action);
    let result: PreviewResult;
    try {
      result = await preview({
        pr: pr.number,
        event,
        name: branch,
        parent,
        runTests,
        artifactsDir: artifactsDir(repo, pr.number),
        source: {
          repo,
          title: pr.title,
          url: pr.htmlUrl,
          author: pr.author ?? undefined,
        },
      });
    } catch (error) {
      const message = errorMessage(error);
      repoState.pullRequests[key] = {
        ...metadata(pr),
        number: pr.number,
        headSha: pr.headSha,
        branch,
        status: "failed",
        event,
        syncedAt: null,
        lastAttemptAt: new Date(now).toISOString(),
        error: message,
      };
      summary.failed += 1;
      summary.pullRequests.push({
        number: pr.number,
        action: decision.action,
        status: "failed",
        branch,
        headSha: pr.headSha,
        error: message,
      });
      log(`#${pr.number} ${decision.action} failed: ${message}`);
      continue;
    }

    repoState.pullRequests[key] = {
      ...metadata(pr),
      number: pr.number,
      headSha: pr.headSha,
      branch,
      status: result.status,
      event,
      syncedAt: new Date().toISOString(),
      lastAttemptAt: new Date(now).toISOString(),
      error: result.error ?? null,
    };

    if (result.status === "ready") {
      if (decision.action === "create") summary.created += 1;
      else if (decision.action === "reopen") summary.reopened += 1;
      else summary.recreated += 1;
    } else {
      summary.failed += 1;
    }

    summary.pullRequests.push({
      number: pr.number,
      action: decision.action,
      status: result.status,
      branch,
      headSha: pr.headSha,
      error: result.error ?? null,
    });
    log(
      `#${pr.number} ${decision.action} → ${result.status} (${branch})`,
    );
  }

  if (fetched.complete) {
    for (const [key, previous] of Object.entries(repoState.pullRequests)) {
      if (open.has(key)) continue;
      if (previous.status === "deleted" || previous.status === "absent") {
        continue;
      }

      try {
        const result = await preview({
          pr: previous.number,
          event: "closed",
          name: previous.branch,
          parent,
          runTests: false,
          artifactsDir: artifactsDir(repo, previous.number),
          source: {
            repo,
            title: previous.title,
            url: previous.url,
            author: previous.author ?? undefined,
          },
        });

        previous.status = result.status;
        previous.event = "closed";
        previous.syncedAt = new Date().toISOString();
        previous.error = result.error ?? null;

        if (result.status === "deleted" || result.status === "absent") {
          summary.deleted += 1;
        } else {
          summary.failed += 1;
        }

        summary.pullRequests.push({
          number: previous.number,
          action: "delete",
          status: result.status,
          branch: previous.branch,
          headSha: previous.headSha,
          error: result.error ?? null,
        });
        log(`#${previous.number} delete → ${result.status}`);
      } catch (error) {
        const message = errorMessage(error);
        previous.status = "failed";
        previous.event = "closed";
        previous.error = message;
        summary.failed += 1;
        summary.pullRequests.push({
          number: previous.number,
          action: "delete",
          status: "failed",
          branch: previous.branch,
          headSha: previous.headSha,
          error: message,
        });
        log(`#${previous.number} delete failed: ${message}`);
      }
    }
  }

  repoState.lastError = null;
  repoState.lastSyncAt = new Date().toISOString();
  summary.finishedAt = new Date().toISOString();
  return summary;
}
