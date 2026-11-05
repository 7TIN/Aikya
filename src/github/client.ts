/**
 * Minimal GitHub REST client for the local repository watcher.
 *
 * Pull-request metadata is read so the watcher can detect open, updated, and
 * closed PRs. Execution is limited to explicitly registered same-repository
 * PRs; fork and unknown-head PRs are skipped and never run code.
 */

const API = "https://api.github.com";
const USER_AGENT = "aikya-db-branch-monitor";
const MAX_PAGES = 10;
const PER_PAGE = 100;

export interface GithubPullRequest {
  number: number;
  title: string;
  state: string;
  draft: boolean;
  mergedAt: string | null;
  htmlUrl: string;
  author: string | null;
  headSha: string;
  headRef: string;
  /** Source repository of the head branch (`owner/name`), when GitHub exposes it. */
  headRepo: string | null;
  /**
   * True when the PR comes from another repository, a fork, or the head repo
   * is unknown. The watcher never executes untrusted PR code.
   */
  headIsFork: boolean;
  baseRef: string;
  createdAt: string;
  updatedAt: string;
}

interface RawPullRequest {
  number?: number;
  title?: string;
  state?: string;
  draft?: boolean;
  merged_at?: string | null;
  html_url?: string;
  user?: { login?: string } | null;
  head?: {
    sha?: string;
    ref?: string;
    repo?: { full_name?: string; fork?: boolean | null } | null;
  } | null;
  base?: { ref?: string } | null;
  created_at?: string;
  updated_at?: string;
}

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Accept `owner/name` and reject anything that could become a URL segment. */
export function parseRepo(value: string): string {
  const repo = value.trim();
  const [owner, name] = repo.split("/");
  const unsafeSegment =
    !owner || !name || owner === "." || owner === ".." || name === "." || name === "..";
  if (!REPO_PATTERN.test(repo) || unsafeSegment) {
    throw new Error(
      `Invalid GitHub repository "${value}". Use the owner/name form, for example 7TIN/gh-lab.`,
    );
  }
  return repo;
}

export function parseRepos(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(parseRepo);
}

export class GithubApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "GithubApiError";
    this.status = status;
  }
}

function headers(token?: string): Record<string, string> {
  const result: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": USER_AGENT,
  };
  if (token) result.Authorization = `Bearer ${token}`;
  return result;
}

function toPullRequest(
  raw: RawPullRequest,
  baseRepo: string,
): GithubPullRequest | null {
  if (typeof raw.number !== "number" || !Number.isInteger(raw.number)) return null;
  const headSha = raw.head?.sha;
  if (!headSha) return null;

  const headRepo = raw.head?.repo?.full_name?.trim() || null;
  const sameRepo =
    headRepo !== null && headRepo.toLowerCase() === baseRepo.toLowerCase();
  const headIsFork = !sameRepo;

  return {
    number: raw.number,
    title: raw.title ?? "(no title)",
    state: raw.state ?? "open",
    draft: raw.draft === true,
    mergedAt: raw.merged_at ?? null,
    htmlUrl: raw.html_url ?? "",
    author: raw.user?.login ?? null,
    headSha,
    headRef: raw.head?.ref ?? "",
    headRepo,
    headIsFork,
    baseRef: raw.base?.ref ?? "main",
    createdAt: raw.created_at ?? "",
    updatedAt: raw.updated_at ?? "",
  };
}

function rateLimitMessage(response: Response): string {
  const remaining = response.headers.get("x-ratelimit-remaining");
  const reset = response.headers.get("x-ratelimit-reset");
  const now = Math.floor(Date.now() / 1000);
  const resetText =
    reset && Number(reset) > now
      ? ` It resets in ${Math.ceil((Number(reset) - now) / 60)} minute(s).`
      : "";
  return (
    `GitHub API rate limit reached (remaining ${remaining ?? "0"}).${resetText} ` +
    "Set GITHUB_TOKEN to a read-only token for a higher limit, or raise GITHUB_POLL_MS."
  );
}

const pageCache = new Map<string, { etag: string; items: GithubPullRequest[] }>();
const pageCacheToken = new Map<string, string | null>();

interface FetchPageOptions {
  repo: string;
  page: number;
  token?: string;
  fetchImpl?: typeof fetch;
}

async function fetchPage(options: FetchPageOptions): Promise<{
  items: GithubPullRequest[];
  hasNext: boolean;
}> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const cacheKey = `${options.repo}#${options.page}`;
  const cached = pageCache.get(cacheKey);
  const cachedToken = pageCacheToken.get(cacheKey) ?? null;

  const url =
    `${API}/repos/${options.repo}/pulls?state=open&per_page=${PER_PAGE}` +
    `&page=${options.page}&sort=updated&direction=desc`;

  const requestHeaders = headers(options.token);
  // A cached response from a different auth mode must not be reused.
  if (cached && cachedToken === (options.token ?? null)) {
    requestHeaders["If-None-Match"] = cached.etag;
  }

  const response = await fetchImpl(url, {
    headers: requestHeaders,
    signal: AbortSignal.timeout(20_000),
  });

  if (response.status === 304 && cached) {
    return {
      items: cached.items.map((item) => ({ ...item })),
      hasNext: cached.items.length === PER_PAGE,
    };
  }

  if (response.status === 403 || response.status === 429) {
    throw new GithubApiError(rateLimitMessage(response), response.status);
  }

  if (response.status === 404) {
    throw new GithubApiError(
      `GitHub repository "${options.repo}" was not found. Check the owner/name and that the repo is public (or set GITHUB_TOKEN).`,
      404,
    );
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new GithubApiError(
      `GitHub API ${response.status} for ${options.repo}: ${text.slice(0, 300)}`,
      response.status,
    );
  }

  const raw = (await response.json()) as unknown;
  const items = Array.isArray(raw)
    ? raw
        .map((entry) => toPullRequest(entry as RawPullRequest, options.repo))
        .filter((entry): entry is GithubPullRequest => entry !== null)
    : [];

  const etag = response.headers.get("etag");
  if (etag) {
    pageCache.set(cacheKey, { etag, items });
    pageCacheToken.set(cacheKey, options.token ?? null);
  }

  return { items, hasNext: items.length === PER_PAGE };
}

export interface ListPullRequestsOptions {
  token?: string;
  fetchImpl?: typeof fetch;
}

/**
 * All open pull requests, following pagination. `complete` is false when the
 * page cap was reached; the caller must not treat missing PRs as closed then.
 */
export async function listOpenPullRequests(
  repo: string,
  options: ListPullRequestsOptions = {},
): Promise<{ pullRequests: GithubPullRequest[]; complete: boolean }> {
  const normalized = parseRepo(repo);
  const pullRequests: GithubPullRequest[] = [];

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const { items, hasNext } = await fetchPage({
      repo: normalized,
      page,
      token: options.token,
      fetchImpl: options.fetchImpl,
    });
    pullRequests.push(...items);
    if (!hasNext) {
      return { pullRequests, complete: true };
    }
  }

  return { pullRequests, complete: false };
}

/** Test helper: forget cached ETags and responses. */
export function clearGithubCache(): void {
  pageCache.clear();
  pageCacheToken.clear();
}
