import { describe, expect, test } from "bun:test";
import type { NeonBranch } from "./branches.ts";
import { selectPrunable } from "./prune.ts";

const NOW = Date.parse("2026-11-03T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function branch(name: string, overrides: Partial<NeonBranch> = {}): NeonBranch {
  return {
    id: `br-${name}`,
    name,
    projectId: "project",
    default: false,
    primary: false,
    protected: false,
    currentState: "ready",
    stateChangedAt: "",
    createdAt: new Date(NOW - 10 * DAY).toISOString(),
    updatedAt: new Date(NOW - 10 * DAY).toISOString(),
    logicalSize: 0,
    writtenDataBytes: 0,
    cpuUsedSec: 0,
    computeTimeSeconds: 0,
    ...overrides,
  };
}

describe("selectPrunable", () => {
  test("selects only branches older than the threshold", () => {
    const result = selectPrunable(
      [
        branch("old"),
        branch("young", { createdAt: new Date(NOW - 2 * DAY).toISOString() }),
      ],
      { olderThanMs: 7 * DAY, parentName: "main", now: NOW },
    );

    expect(result.map((entry) => entry.branch.name)).toEqual(["old"]);
    expect(result[0]?.reason).toBe("age");
  });

  test("never selects main, default, primary, or protected branches", () => {
    const result = selectPrunable(
      [
        branch("main"),
        branch("default", { default: true }),
        branch("primary", { primary: true }),
        branch("protected", { protected: true }),
        branch("parent", { name: "staging" }),
      ],
      { olderThanMs: 1 * DAY, parentName: "staging", now: NOW },
    );

    expect(result).toEqual([]);
  });

  test("respects a prefix and prefers expired branches", () => {
    const result = selectPrunable(
      [
        branch("preview/pr-1", {
          createdAt: new Date(NOW - 1 * DAY).toISOString(),
          expiresAt: new Date(NOW - 60_000).toISOString(),
        }),
        branch("preview/pr-2", {
          createdAt: new Date(NOW - 20 * DAY).toISOString(),
        }),
        branch("agent/task-1", {
          createdAt: new Date(NOW - 20 * DAY).toISOString(),
        }),
      ],
      {
        olderThanMs: 7 * DAY,
        prefix: "preview/",
        parentName: "main",
        now: NOW,
      },
    );

    expect(result.map((entry) => entry.branch.name)).toEqual([
      "preview/pr-2",
      "preview/pr-1",
    ]);
    expect(result.find((entry) => entry.branch.name === "preview/pr-1")?.reason).toBe(
      "expired",
    );
  });
});
