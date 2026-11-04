import { describe, expect, test } from "bun:test";
import type { PreviewEvent } from "../ci/events.ts";
import type { PreviewOptions, PreviewResult } from "../ci/preview.ts";
import type { GithubPullRequest } from "./client.ts";
import {
  artifactDirFor,
  decideAction,
  emptyMonitorState,
  monitorBranchName,
  normalizeMonitorState,
  repoSegment,
  syncRepository,
  type TrackedPullRequest,
} from "./monitor.ts";

const NOW = Date.parse("2026-11-04T10:00:00Z");

function pullRequest(
  overrides: Partial<GithubPullRequest> = {},
): GithubPullRequest {
  return {
    number: 7,
    title: "Add widget",
    state: "open",
    draft: false,
    mergedAt: null,
    htmlUrl: "https://github.com/7TIN/gh-lab/pull/7",
    author: "octocat",
    headSha: "abc1234",
    headRef: "feature",
    baseRef: "main",
    createdAt: "2026-11-04T09:00:00Z",
    updatedAt: "2026-11-04T09:30:00Z",
    ...overrides,
  };
}

function tracked(
  overrides: Partial<TrackedPullRequest> = {},
): TrackedPullRequest {
  return {
    number: 7,
    title: "Add widget",
    author: "octocat",
    url: "https://github.com/7TIN/gh-lab/pull/7",
    draft: false,
    headSha: "abc1234",
    branch: "preview/7tin-gh-lab-pr-7",
    status: "ready",
    event: "opened",
    syncedAt: "2026-11-04T09:30:00Z",
    lastAttemptAt: "2026-11-04T09:30:00Z",
    error: null,
    ...overrides,
  };
}

function previewResult(
  options: PreviewOptions,
  status: PreviewResult["status"] = "ready",
  error?: string,
): PreviewResult {
  return {
    pr: Number(options.pr),
    event: options.event as PreviewEvent,
    action: "create",
    status,
    branch: options.name ?? `preview/pr-${options.pr}`,
    parent: options.parent ?? "main",
    reason: "test",
    steps: [],
    comment: "",
    source: options.source,
    error,
  };
}

describe("repo scoping", () => {
  test("namespaces branches and artifact dirs by repository", () => {
    expect(repoSegment("7TIN/gh-lab")).toBe("7tin-gh-lab");
    expect(monitorBranchName("7TIN/gh-lab", 7)).toBe(
      "preview/7tin-gh-lab-pr-7",
    );
    expect(artifactDirFor("7TIN/gh-lab", 7).replace(/\\/g, "/")).toEndWith(
      "/artifacts/preview/7tin-gh-lab-pr-7",
    );
  });

  test("keeps the PR suffix when a repository name is long", () => {
    const repo = `${"a".repeat(50)}/${"b".repeat(50)}`;
    const name = monitorBranchName(repo, 12345);

    expect(name.length).toBeLessThanOrEqual(63);
    expect(name).toStartWith("preview/");
    expect(name).toEndWith("-pr-12345");
  });

  test("disambiguates long repository names that share a prefix", () => {
    const prefix = `${"a".repeat(40)}/${"b".repeat(40)}`;
    const first = monitorBranchName(`${prefix}-one`, 7);
    const second = monitorBranchName(`${prefix}-two`, 7);

    expect(first.length).toBeLessThanOrEqual(63);
    expect(second.length).toBeLessThanOrEqual(63);
    expect(first).not.toBe(second);
  });

  test("never produces an empty repository segment", () => {
    expect(repoSegment("___/___")).toBe("repo");
    expect(monitorBranchName("___/___", 7)).toBe("preview/repo-pr-7");
  });

  test("normalizes partial state files", () => {
    const state = normalizeMonitorState({
      repos: {
        "7TIN/gh-lab": {
          pullRequests: {
            "7": { number: 7, branch: "preview/7tin-gh-lab-pr-7" },
            garbage: {},
          },
        },
      },
    });

    expect(Object.keys(state.repos["7TIN/gh-lab"]?.pullRequests ?? {})).toEqual([
      "7",
    ]);
    expect(state.repos["7TIN/gh-lab"]?.lastError).toBeNull();
  });
});

describe("decideAction", () => {
  test("creates a branch for a new pull request", () => {
    expect(decideAction(undefined, pullRequest()).action).toBe("create");
  });

  test("skips an unchanged, ready branch", () => {
    expect(decideAction(tracked(), pullRequest()).action).toBe("skip");
  });

  test("recreates when the head commit changed", () => {
    const decision = decideAction(
      tracked({ headSha: "old0000" }),
      pullRequest({ headSha: "new1111" }),
    );
    expect(decision.action).toBe("recreate");
    expect(decision.reason).toContain("head commit changed");
  });

  test("reopens a deleted branch for a reopened pull request", () => {
    expect(
      decideAction(tracked({ status: "deleted" }), pullRequest()).action,
    ).toBe("reopen");
  });

  test("backs off after a recent failure", () => {
    const decision = decideAction(
      tracked({
        status: "failed",
        lastAttemptAt: new Date(NOW - 60_000).toISOString(),
      }),
      pullRequest(),
      { now: NOW, retryMs: 5 * 60_000 },
    );
    expect(decision.action).toBe("retry");
  });

  test("retries a failed branch after the backoff window", () => {
    const decision = decideAction(
      tracked({
        status: "failed",
        lastAttemptAt: new Date(NOW - 6 * 60_000).toISOString(),
      }),
      pullRequest(),
      { now: NOW, retryMs: 5 * 60_000 },
    );
    expect(decision.action).toBe("create");
  });
});

interface Harness {
  state: ReturnType<typeof emptyMonitorState>;
  calls: PreviewOptions[];
  sync: (
    open: GithubPullRequest[],
    options?: {
      complete?: boolean;
      now?: number;
      failFetch?: boolean;
      status?: PreviewResult["status"];
    },
  ) => ReturnType<typeof syncRepository>;
}

function harness(): Harness {
  const state = emptyMonitorState();
  const calls: PreviewOptions[] = [];

  const sync: Harness["sync"] = (open, options = {}) =>
    syncRepository({
      repo: "7TIN/gh-lab",
      state,
      runTests: false,
      artifactsDir: () => "/tmp/db-branch-test-artifacts",
      deps: {
        now: () => options.now ?? NOW,
        fetchPullRequests: async () => {
          if (options.failFetch) throw new Error("GitHub API is down");
          return {
            pullRequests: open,
            complete: options.complete ?? true,
          };
        },
        preview: async (previewOptions) => {
          calls.push(previewOptions);
          if (previewOptions.event === "closed") {
            return previewResult(previewOptions, "deleted");
          }
          return previewResult(
            previewOptions,
            options.status ?? "ready",
            options.status === "failed" ? "migration failed" : undefined,
          );
        },
      },
    });

  return { state, calls, sync };
}

describe("syncRepository", () => {
  test("creates a scoped branch for a new pull request", async () => {
    const test = harness();
    const summary = await test.sync([pullRequest()]);

    expect(summary.created).toBe(1);
    expect(test.calls).toHaveLength(1);
    expect(test.calls[0]?.event).toBe("opened");
    expect(test.calls[0]?.name).toBe("preview/7tin-gh-lab-pr-7");
    expect(test.calls[0]?.source?.repo).toBe("7TIN/gh-lab");

    const entry = test.state.repos["7TIN/gh-lab"]?.pullRequests["7"];
    expect(entry?.status).toBe("ready");
    expect(entry?.headSha).toBe("abc1234");
  });

  test("skips an unchanged pull request", async () => {
    const test = harness();
    await test.sync([pullRequest()]);
    const summary = await test.sync([pullRequest()]);

    expect(summary.unchanged).toBe(1);
    expect(test.calls).toHaveLength(1);
  });

  test("recreates when a new commit is pushed", async () => {
    const test = harness();
    await test.sync([pullRequest()]);
    const summary = await test.sync([pullRequest({ headSha: "def5678" })]);

    expect(summary.recreated).toBe(1);
    expect(test.calls).toHaveLength(2);
    expect(test.calls[1]?.event).toBe("synchronize");
  });

  test("deletes the branch once the pull request closes", async () => {
    const test = harness();
    await test.sync([pullRequest()]);
    const summary = await test.sync([]);

    expect(summary.deleted).toBe(1);
    expect(test.calls[1]?.event).toBe("closed");
    expect(test.calls[1]?.name).toBe("preview/7tin-gh-lab-pr-7");
    expect(
      test.state.repos["7TIN/gh-lab"]?.pullRequests["7"]?.status,
    ).toBe("deleted");
  });

  test("never deletes on a partial page", async () => {
    const test = harness();
    await test.sync([pullRequest()]);
    const summary = await test.sync([], { complete: false });

    expect(summary.deleted).toBe(0);
    expect(test.calls).toHaveLength(1);
  });

  test("records failures and retries only after the backoff", async () => {
    const test = harness();
    const first = await test.sync([pullRequest()], { status: "failed" });
    expect(first.failed).toBe(1);

    const second = await test.sync([pullRequest()], {
      now: NOW + 60_000,
      status: "failed",
    });
    expect(second.unchanged).toBe(1);
    expect(test.calls).toHaveLength(1);

    const third = await test.sync([pullRequest()], {
      now: NOW + 6 * 60_000,
      status: "failed",
    });
    expect(third.failed).toBe(1);
    expect(test.calls).toHaveLength(2);
  });

  test("reports a GitHub API error without touching branches", async () => {
    const test = harness();
    const summary = await test.sync([], { failFetch: true });

    expect(summary.error).toContain("GitHub API is down");
    expect(test.calls).toHaveLength(0);
    expect(test.state.repos["7TIN/gh-lab"]?.lastError).toContain(
      "GitHub API is down",
    );
  });
});
