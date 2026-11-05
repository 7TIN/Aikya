import { describe, expect, test } from "bun:test";
import { listOpenPullRequests, parseRepo, parseRepos } from "./client.ts";

describe("parseRepo", () => {
  test("accepts owner/name and trims whitespace", () => {
    expect(parseRepo(" 7TIN/gh-lab ")).toBe("7TIN/gh-lab");
  });

  test("accepts dots, underscores, and hyphens", () => {
    expect(parseRepo("my_org/my.repo-name")).toBe("my_org/my.repo-name");
  });

  test("rejects malformed values", () => {
    for (const value of [
      "",
      "gh-lab",
      "owner/",
      "/repo",
      "owner/repo/extra",
      "owner repo/name",
      "https://github.com/owner/repo",
    ]) {
      expect(() => parseRepo(value)).toThrow(/Invalid GitHub repository/);
    }
  });

  test("rejects dot-segments that could escape the URL path", () => {
    expect(() => parseRepo("owner/..")).toThrow(/Invalid GitHub repository/);
    expect(() => parseRepo("../repo")).toThrow(/Invalid GitHub repository/);
    expect(() => parseRepo("./repo")).toThrow(/Invalid GitHub repository/);
  });
});

describe("parseRepos", () => {
  test("splits a comma-separated list", () => {
    expect(parseRepos("7TIN/gh-lab, owner/two")).toEqual([
      "7TIN/gh-lab",
      "owner/two",
    ]);
  });

  test("returns an empty list for an unset value", () => {
    expect(parseRepos(undefined)).toEqual([]);
    expect(parseRepos("")).toEqual([]);
    expect(parseRepos(" , ")).toEqual([]);
  });
});

describe("listOpenPullRequests", () => {
  function rawPullRequest(
    headRepo: string | null,
    fork: boolean | null,
  ): Record<string, unknown> {
    return {
      number: 7,
      title: "Add widget",
      state: "open",
      draft: false,
      merged_at: null,
      html_url: "https://github.com/base/repo/pull/7",
      user: { login: "octocat" },
      head: {
        sha: "abc1234",
        ref: "feature",
        ...(headRepo === null
          ? {}
          : { repo: { full_name: headRepo, fork } }),
      },
      base: { ref: "main" },
      created_at: "2026-11-04T09:00:00Z",
      updated_at: "2026-11-04T09:30:00Z",
    };
  }

  function fetchOnce(body: unknown): typeof fetch {
    return (async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
  }

  test("marks same-repository PRs as trusted", async () => {
    const result = await listOpenPullRequests("base/repo", {
      fetchImpl: fetchOnce([rawPullRequest("base/repo", false)]),
    });
    expect(result.complete).toBe(true);
    expect(result.pullRequests[0]).toMatchObject({
      headRepo: "base/repo",
      headIsFork: false,
    });
  });

  test("marks fork PRs as untrusted", async () => {
    const result = await listOpenPullRequests("base/repo", {
      fetchImpl: fetchOnce([rawPullRequest("fork/repo", true)]),
    });
    expect(result.pullRequests[0]?.headIsFork).toBe(true);
  });

  test("treats a missing head repository as untrusted", async () => {
    const result = await listOpenPullRequests("base/repo", {
      fetchImpl: fetchOnce([rawPullRequest(null, null)]),
    });
    expect(result.pullRequests[0]?.headRepo).toBeNull();
    expect(result.pullRequests[0]?.headIsFork).toBe(true);
  });
});
