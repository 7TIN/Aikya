import { describe, expect, test } from "bun:test";
import { resolveWatchConfig, unconfiguredWatchStatus } from "./service.ts";

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
