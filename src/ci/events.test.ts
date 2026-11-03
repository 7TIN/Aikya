import { describe, expect, test } from "bun:test";
import {
  parsePreviewEvent,
  parsePullRequestNumber,
  planPreview,
  previewBranchName,
  sanitizeBranchName,
} from "./events.ts";

describe("parsePreviewEvent", () => {
  test("accepts supported pull_request actions", () => {
    expect(parsePreviewEvent("opened")).toBe("opened");
    expect(parsePreviewEvent("synchronize")).toBe("synchronize");
    expect(parsePreviewEvent("reopened")).toBe("reopened");
    expect(parsePreviewEvent("closed")).toBe("closed");
    expect(parsePreviewEvent(" OPENED ")).toBe("opened");
  });

  test("rejects unknown events", () => {
    expect(() => parsePreviewEvent("labeled")).toThrow();
    expect(() => parsePreviewEvent("")).toThrow();
  });
});

describe("parsePullRequestNumber", () => {
  test("accepts numbers and #-prefixed strings", () => {
    expect(parsePullRequestNumber(123)).toBe(123);
    expect(parsePullRequestNumber("123")).toBe(123);
    expect(parsePullRequestNumber("#123")).toBe(123);
  });

  test("rejects zero, negative, fractional, and non-numeric values", () => {
    expect(() => parsePullRequestNumber("0")).toThrow();
    expect(() => parsePullRequestNumber("-1")).toThrow();
    expect(() => parsePullRequestNumber("1.5")).toThrow();
    expect(() => parsePullRequestNumber("abc")).toThrow();
    expect(() => parsePullRequestNumber("")).toThrow();
  });
});

describe("previewBranchName", () => {
  test("derives a deterministic branch from the PR number", () => {
    expect(previewBranchName(123)).toBe("preview/pr-123");
    expect(previewBranchName(7)).toBe("preview/pr-7");
  });

  test("sanitizes custom names", () => {
    expect(previewBranchName(123, "My Feature/Thing!")).toBe("my-feature/thing");
  });
});

describe("sanitizeBranchName", () => {
  test("lowercases and removes unsafe characters", () => {
    expect(sanitizeBranchName("PR 42 — Fix: coupons!")).toBe("pr-42-fix-coupons");
    expect(sanitizeBranchName("///preview//pr-42///")).toBe("preview/pr-42");
  });

  test("caps length and rejects empty results", () => {
    expect(sanitizeBranchName("a".repeat(100)).length).toBe(63);
    expect(() => sanitizeBranchName("!!!")).toThrow();
  });
});

describe("planPreview", () => {
  test("creates on opened/reopened and recreates on synchronize", () => {
    expect(planPreview("opened").action).toBe("create");
    expect(planPreview("reopened").action).toBe("create");
    expect(planPreview("synchronize").action).toBe("recreate");
  });

  test("deletes on closed, even for a fork", () => {
    expect(planPreview("closed").action).toBe("delete");
    expect(planPreview("closed", { fork: true }).action).toBe("delete");
  });

  test("skips fork PRs instead of exposing secrets", () => {
    const plan = planPreview("opened", { fork: true });
    expect(plan.action).toBe("skip");
    expect(plan.reason).toContain("secrets");
    expect(planPreview("synchronize", { fork: true }).action).toBe("skip");
  });
});
