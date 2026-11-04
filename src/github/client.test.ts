import { describe, expect, test } from "bun:test";
import { parseRepo, parseRepos } from "./client.ts";

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
