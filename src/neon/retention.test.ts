import { describe, expect, test } from "bun:test";
import type { NeonBranch } from "./branches.ts";
import {
  branchWarnings,
  isManagedPreviewBranch,
  STALE_AFTER_MS,
  warningsByBranch,
} from "./retention.ts";

const NOW = Date.parse("2026-11-12T12:00:00.000Z");

function branch(name: string, overrides: Partial<NeonBranch> = {}): NeonBranch {
  return {
    id: `br-${name}`,
    name,
    projectId: "proj",
    default: false,
    primary: false,
    protected: false,
    currentState: "ready",
    stateChangedAt: "",
    createdAt: new Date(NOW - 1_000).toISOString(),
    updatedAt: new Date(NOW - 1_000).toISOString(),
    logicalSize: 0,
    writtenDataBytes: 0,
    cpuUsedSec: 0,
    computeTimeSeconds: 0,
    ...overrides,
  };
}

function oldBranch(name: string, overrides: Partial<NeonBranch> = {}): NeonBranch {
  return branch(name, {
    createdAt: new Date(NOW - 8 * 24 * 60 * 60 * 1_000).toISOString(),
    ...overrides,
  });
}

describe("isManagedPreviewBranch", () => {
  test("distinguishes repo-scoped previews from Aikya's own", () => {
    expect(isManagedPreviewBranch("preview/7tin-gh-lab-pr-3")).toBe(true);
    expect(isManagedPreviewBranch("preview/pr-3")).toBe(false);
    expect(isManagedPreviewBranch("staging")).toBe(false);
  });
});

describe("branchWarnings", () => {
  test("warns when a TTL has expired", () => {
    const warnings = branchWarnings(
      [
        branch("preview/7tin-gh-lab-pr-1", {
          expiresAt: new Date(NOW - 60_000).toISOString(),
        }),
      ],
      { staleAfterMs: STALE_AFTER_MS, now: NOW },
    );

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      code: "expired",
      branch: "preview/7tin-gh-lab-pr-1",
    });
    expect(warnings[0]?.message).toContain("1m ago");
  });

  test("warns when an unexpired branch is older than the stale threshold", () => {
    const warnings = branchWarnings(
      [
        branch("preview/7tin-gh-lab-pr-2", {
          createdAt: new Date(NOW - 8 * 24 * 60 * 60 * 1_000).toISOString(),
        }),
      ],
      { staleAfterMs: STALE_AFTER_MS, now: NOW },
    );

    expect(warnings.map((warning) => warning.code)).toEqual(["stale"]);
  });

  test("does not call a fresh branch stale", () => {
    const warnings = branchWarnings(
      [branch("preview/7tin-gh-lab-pr-3")],
      { staleAfterMs: STALE_AFTER_MS, now: NOW },
    );
    expect(warnings).toEqual([]);
  });

  test("flags repo-scoped previews without a tracked owner", () => {
    const warnings = branchWarnings(
      [
        branch("preview/7tin-gh-lab-pr-1"),
        branch("preview/7tin-gh-lab-pr-2"),
        branch("preview/pr-9"),
        branch("staging"),
      ],
      {
        staleAfterMs: STALE_AFTER_MS,
        ownedBranches: new Set(["preview/7tin-gh-lab-pr-1"]),
        now: NOW,
      },
    );

    expect(warnings.map((warning) => warning.branch)).toEqual([
      "preview/7tin-gh-lab-pr-2",
    ]);
    expect(warnings[0]?.code).toBe("missing-owner");
  });

  test("skips missing-owner warnings when ownership is unknown", () => {
    const warnings = branchWarnings(
      [branch("preview/7tin-gh-lab-pr-1")],
      { staleAfterMs: STALE_AFTER_MS, now: NOW },
    );
    expect(warnings).toEqual([]);
  });

  test("never warns about protected or default branches", () => {
    const warnings = branchWarnings(
      [
        branch("main", { default: true, primary: true, protected: true }),
        branch("staging", { protected: true }),
        oldBranch("qa"),
      ],
      {
        staleAfterMs: STALE_AFTER_MS,
        ownedBranches: new Set(),
        protectedNames: ["staging", "qa"],
        now: NOW,
      },
    );
    expect(warnings).toEqual([]);
  });

  test("groups warnings by branch", () => {
    const grouped = warningsByBranch([
      { code: "expired", branch: "preview/a-pr-1", ageMs: 1, message: "x" },
      { code: "missing-owner", branch: "preview/a-pr-1", ageMs: 1, message: "y" },
      { code: "stale", branch: "preview/a-pr-2", ageMs: 2, message: "z" },
    ]);

    expect(grouped.get("preview/a-pr-1")).toHaveLength(2);
    expect(grouped.get("preview/a-pr-2")).toHaveLength(1);
  });
});
