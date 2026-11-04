import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWatchConfig, unconfiguredWatchStatus, WatchService } from "./service.ts";

describe("resolveWatchConfig", () => {
  test("returns null when no repository is configured", () => {
    expect(resolveWatchConfig({})).toBeNull();
  });

  test("applies safe defaults", () => {
    expect(resolveWatchConfig({ GITHUB_REPO: "7TIN/gh-lab" })).toEqual({
      repos: ["7TIN/gh-lab"],
      pollMs: 120_000,
      watchOnStart: true,
      parent: undefined,
      runTests: true,
      retryMs: undefined,
      statePath: undefined,
    });
  });

  test("accepts a comma-separated repository list", () => {
    const config = resolveWatchConfig({
      GITHUB_REPOS: "7TIN/gh-lab, owner/two",
    });
    expect(config?.repos).toEqual(["7TIN/gh-lab", "owner/two"]);
  });

  test("GITHUB_REPOS wins over GITHUB_REPO", () => {
    const config = resolveWatchConfig({
      GITHUB_REPO: "ignored/one",
      GITHUB_REPOS: "used/two",
    });
    expect(config?.repos).toEqual(["used/two"]);
  });

  test("reads flags, parent, retry backoff, and state path", () => {
    const config = resolveWatchConfig({
      GITHUB_REPO: "7TIN/gh-lab",
      GITHUB_POLL_MS: "60000",
      GITHUB_WATCH_ON_START: "false",
      GITHUB_WATCH_TESTS: "false",
      NEON_PARENT_BRANCH: "staging",
      GITHUB_WATCH_RETRY_MS: "120000",
      GITHUB_WATCH_STATE: "artifacts/monitor/test-state.json",
    });

    expect(config).toMatchObject({
      pollMs: 60_000,
      watchOnStart: false,
      runTests: false,
      parent: "staging",
      retryMs: 120_000,
      statePath: "artifacts/monitor/test-state.json",
    });
  });

  test("GITHUB_WATCH_PARENT is a fallback for the parent branch", () => {
    const config = resolveWatchConfig({
      GITHUB_REPO: "7TIN/gh-lab",
      GITHUB_WATCH_PARENT: "qa",
    });
    expect(config?.parent).toBe("qa");
  });

  test("clamps the poll interval to protect the unauthenticated rate limit", () => {
    const config = resolveWatchConfig({
      GITHUB_REPO: "7TIN/gh-lab",
      GITHUB_POLL_MS: "1000",
    });
    expect(config?.pollMs).toBe(15_000);
  });

  test("rejects invalid intervals", () => {
    expect(() =>
      resolveWatchConfig({ GITHUB_REPO: "7TIN/gh-lab", GITHUB_POLL_MS: "soon" }),
    ).toThrow(/Invalid GITHUB_POLL_MS/);
    expect(() =>
      resolveWatchConfig({
        GITHUB_REPO: "7TIN/gh-lab",
        GITHUB_WATCH_RETRY_MS: "-1",
      }),
    ).toThrow(/Invalid GITHUB_WATCH_RETRY_MS/);
  });
});

describe("unconfiguredWatchStatus", () => {
  test("is a disabled, empty payload for the dashboard", () => {
    expect(unconfiguredWatchStatus()).toEqual({
      configured: false,
      repos: [],
      pollMs: 0,
      autoPoll: false,
      syncing: false,
      lastRunAt: null,
      lastError: null,
      summaries: [],
      pullRequests: [],
    });
  });
});

describe("WatchService", () => {
  test("marks a manually deleted branch so the next poll recreates it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aikya-watch-"));
    const statePath = join(dir, "state.json");

    try {
      await writeFile(
        statePath,
        JSON.stringify({
          version: 1,
          repos: {
            "7TIN/gh-lab": {
              lastSyncAt: null,
              lastError: null,
              pullRequests: {
                "7": {
                  number: 7,
                  title: "Add widget",
                  author: "octocat",
                  url: "https://github.com/7TIN/gh-lab/pull/7",
                  draft: false,
                  headSha: "abc1234",
                  branch: "preview/7tin-gh-lab-pr-7",
                  status: "ready",
                  event: "opened",
                  syncedAt: "2026-11-04T10:00:00Z",
                  lastAttemptAt: "2026-11-04T10:00:00Z",
                  error: null,
                },
              },
            },
          },
        }),
        "utf8",
      );

      const service = new WatchService({
        repos: ["7TIN/gh-lab"],
        pollMs: 120_000,
        watchOnStart: false,
        runTests: false,
        statePath,
      });

      expect(
        await service.markBranchDeleted("preview/7tin-gh-lab-pr-7"),
      ).toBe(true);
      expect(service.status().pullRequests[0]?.status).toBe("deleted");

      const saved = JSON.parse(await readFile(statePath, "utf8")) as {
        repos: Record<string, { pullRequests: Record<string, { status: string }> }>;
      };
      expect(
        saved.repos["7TIN/gh-lab"]?.pullRequests["7"]?.status,
      ).toBe("deleted");

      expect(
        await service.markBranchDeleted("preview/7tin-gh-lab-pr-99"),
      ).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
