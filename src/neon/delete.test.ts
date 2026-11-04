import { describe, expect, test } from "bun:test";
import type { NeonBranch } from "./branches.ts";
import { branchDeleteBlockedReason } from "./delete.ts";

function branch(
  overrides: Partial<NeonBranch> & { name: string },
): NeonBranch {
  return {
    id: `br-${overrides.name}`,
    projectId: "test",
    default: false,
    primary: false,
    protected: false,
    currentState: "ready",
    stateChangedAt: "2026-11-04T10:00:00Z",
    createdAt: "2026-11-04T10:00:00Z",
    updatedAt: "2026-11-04T10:00:00Z",
    logicalSize: 0,
    writtenDataBytes: 0,
    cpuUsedSec: 0,
    computeTimeSeconds: 0,
    ...overrides,
    name: overrides.name,
  };
}

describe("branchDeleteBlockedReason", () => {
  test("allows preview and ad-hoc branches", () => {
    expect(branchDeleteBlockedReason(branch({ name: "preview/pr-1" }))).toBeNull();
    expect(
      branchDeleteBlockedReason(branch({ name: "preview/7tin-gh-lab-pr-1" })),
    ).toBeNull();
    expect(branchDeleteBlockedReason(branch({ name: "demo-coupons" }))).toBeNull();
  });

  test("protects default, primary, and Neon-protected branches", () => {
    expect(
      branchDeleteBlockedReason(branch({ name: "main", default: true })),
    ).toBe("the default branch");
    expect(
      branchDeleteBlockedReason(branch({ name: "main", primary: true })),
    ).toBe("the primary branch");
    expect(
      branchDeleteBlockedReason(branch({ name: "keep-me", protected: true })),
    ).toBe("a Neon-protected branch");
  });

  test("protects main, the configured parent, and environments", () => {
    expect(branchDeleteBlockedReason(branch({ name: "main" }))).toBe(
      "the main branch",
    );
    expect(branchDeleteBlockedReason(branch({ name: "staging" }))).toBe(
      "a persistent environment branch",
    );
    expect(branchDeleteBlockedReason(branch({ name: "qa" }))).toBe(
      "a persistent environment branch",
    );
  });
});
