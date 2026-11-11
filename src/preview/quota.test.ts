import { describe, expect, test } from "bun:test";
import type { AikyaEvent } from "../events/log.ts";
import type { NeonBranch } from "../neon/branches.ts";
import {
  assertQuota,
  computeQuotaUsage,
  DEFAULT_QUOTA_LIMITS,
  evaluateQuota,
  formatQuotaUsage,
  parseQuota,
  QuotaExceededError,
  quotaLimitsFromEnv,
  resolveQuotaLimits,
} from "./quota.ts";

const NOW = Date.parse("2026-11-11T12:00:00.000Z");
const REPO = "7TIN/gh-lab";

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
    createdAt: "2026-11-11T00:00:00.000Z",
    updatedAt: "2026-11-11T00:00:00.000Z",
    logicalSize: 0,
    writtenDataBytes: 0,
    cpuUsedSec: 0,
    computeTimeSeconds: 0,
    ...overrides,
  };
}

function event(
  type: AikyaEvent["type"],
  overrides: Partial<AikyaEvent> = {},
): AikyaEvent {
  return {
    id: "1",
    type,
    at: new Date(NOW - 60_000).toISOString(),
    repo: REPO,
    ...overrides,
  };
}

describe("quota limits", () => {
  test("uses built-in defaults and applies env values", () => {
    expect(resolveQuotaLimits(undefined, {})).toEqual(DEFAULT_QUOTA_LIMITS);

    const env = quotaLimitsFromEnv({
      AIKYA_QUOTA_MAX_BRANCHES: "4",
      AIKYA_QUOTA_MAX_STORAGE_DELTA_MB: "16",
      AIKYA_QUOTA_MAX_SANDBOX_MINUTES_PER_DAY: "5",
      AIKYA_QUOTA_MAX_CREATES_PER_HOUR: "2",
    });
    expect(env).toEqual({
      maxBranches: 4,
      maxStorageDeltaBytes: 16 * 1024 * 1024,
      maxSandboxMinutesPerDay: 5,
      maxCreatesPerHour: 2,
    });
  });

  test("registry values win over env values", () => {
    const limits = resolveQuotaLimits(
      { maxBranches: 2 },
      { AIKYA_QUOTA_MAX_BRANCHES: "9" },
    );
    expect(limits.maxBranches).toBe(2);
  });

  test("ignores invalid environment values", () => {
    const limits = resolveQuotaLimits(undefined, {
      AIKYA_QUOTA_MAX_BRANCHES: "0",
      AIKYA_QUOTA_MAX_CREATES_PER_HOUR: "nope",
    });
    expect(limits).toEqual(DEFAULT_QUOTA_LIMITS);
  });

  test("parseQuota validates keys and values", () => {
    expect(parseQuota({ maxBranches: 3 }, "repos.json", REPO)).toEqual({
      maxBranches: 3,
    });
    expect(() => parseQuota({ branchCap: 3 }, "repos.json", REPO)).toThrow(
      /quota has unknown key "branchCap"/,
    );
    expect(() => parseQuota({ maxBranches: -1 }, "repos.json", REPO)).toThrow(
      /quota\.maxBranches must be a positive number/,
    );
  });
});

describe("computeQuotaUsage", () => {
  test("counts only this repo's preview branches", () => {
    const usage = computeQuotaUsage({
      repo: REPO,
      now: NOW,
      branches: [
        branch("main"),
        branch("preview/7tin-gh-lab-pr-1"),
        branch("preview/7tin-gh-lab-pr-2"),
        branch("preview/other-repo-pr-9"),
        branch("staging"),
      ],
      events: [],
    });
    expect(usage.branches).toBe(2);
  });

  test("uses the newest report per live branch and ignores deleted branches", () => {
    const usage = computeQuotaUsage({
      repo: REPO,
      now: NOW,
      branches: [branch("preview/7tin-gh-lab-pr-1")],
      events: [
        event("branch.report", {
          branch: "preview/7tin-gh-lab-pr-1",
          at: new Date(NOW - 10_000).toISOString(),
          detail: { sizeDeltaBytes: 300 },
        }),
        event("branch.report", {
          branch: "preview/7tin-gh-lab-pr-1",
          at: new Date(NOW - 20_000).toISOString(),
          detail: { sizeDeltaBytes: 100 },
        }),
        event("branch.report", {
          branch: "preview/7tin-gh-lab-pr-2",
          at: new Date(NOW - 10_000).toISOString(),
          detail: { sizeDeltaBytes: 9_999 },
        }),
      ],
    });
    expect(usage.storageDeltaBytes).toBe(300);
  });

  test("counts sandbox time in the last 24 hours only", () => {
    const usage = computeQuotaUsage({
      repo: REPO,
      now: NOW,
      branches: [],
      events: [
        event("sync.finished", {
          durationMs: 60_000,
          at: new Date(NOW - 60_000).toISOString(),
        }),
        event("sync.finished", {
          durationMs: 60_000,
          at: new Date(NOW - 2 * 24 * 60 * 60 * 1_000).toISOString(),
        }),
        event("review.completed", {
          durationMs: 60_000,
          at: new Date(NOW - 60_000).toISOString(),
        }),
      ],
    });
    expect(usage.sandboxSeconds).toBe(60);
  });

  test("counts creations in the last hour", () => {
    const usage = computeQuotaUsage({
      repo: REPO,
      now: NOW,
      branches: [],
      events: [
        event("branch.created", { at: new Date(NOW - 30_000).toISOString() }),
        event("branch.created", {
          at: new Date(NOW - 2 * 60 * 60 * 1_000).toISOString(),
        }),
      ],
    });
    expect(usage.createsLastHour).toBe(1);
  });
});

describe("evaluateQuota", () => {
  test("allows a run under every limit", () => {
    const decision = evaluateQuota({
      repo: REPO,
      now: NOW,
      branches: [branch("preview/7tin-gh-lab-pr-1")],
      events: [],
      limits: { maxBranches: 5 },
      addBranch: true,
    });
    expect(decision.allowed).toBe(true);
    expect(decision.message).toBeNull();
  });

  test("refuses a new branch with the limit in the message", () => {
    const decision = evaluateQuota({
      repo: REPO,
      now: NOW,
      branches: [
        branch("preview/7tin-gh-lab-pr-1"),
        branch("preview/7tin-gh-lab-pr-2"),
      ],
      events: [],
      limits: { maxBranches: 2 },
      addBranch: true,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.violations.map((entry) => entry.code)).toEqual([
      "maxBranches",
    ]);
    expect(decision.message).toContain("limit 2 branches");
    expect(decision.message).toContain("3 preview branches");
  });

  test("replacing an existing branch does not consume an extra slot", () => {
    const decision = evaluateQuota({
      repo: REPO,
      now: NOW,
      branches: [
        branch("preview/7tin-gh-lab-pr-1"),
        branch("preview/7tin-gh-lab-pr-2"),
      ],
      events: [],
      limits: { maxBranches: 2 },
      addBranch: false,
    });
    expect(decision.allowed).toBe(true);
  });

  test("refuses over the storage, sandbox, and churn limits", () => {
    const decision = evaluateQuota({
      repo: REPO,
      now: NOW,
      branches: [branch("preview/7tin-gh-lab-pr-1")],
      events: [
        event("branch.report", {
          branch: "preview/7tin-gh-lab-pr-1",
          detail: { sizeDeltaBytes: 12 * 1024 * 1024 },
        }),
        event("sync.finished", { durationMs: 5 * 60_000 }),
        event("branch.created"),
      ],
      limits: {
        maxBranches: 5,
        maxStorageDeltaBytes: 8 * 1024 * 1024,
        maxSandboxMinutesPerDay: 2,
        maxCreatesPerHour: 1,
      },
      addBranch: true,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.violations.map((entry) => entry.code).sort()).toEqual([
      "maxCreatesPerHour",
      "maxSandboxMinutesPerDay",
      "maxStorageDeltaBytes",
    ]);
    expect(decision.message).toContain("limit 8.0 MiB");
    expect(decision.message).toContain("limit 2 min");
    expect(decision.message).toContain("limit 1/hour");
  });

  test("assertQuota throws a typed error carrying the decision", () => {
    const decision = evaluateQuota({
      repo: REPO,
      now: NOW,
      branches: [branch("preview/7tin-gh-lab-pr-1")],
      events: [],
      limits: { maxBranches: 1 },
      addBranch: true,
    });

    expect(() => assertQuota(decision)).toThrow(QuotaExceededError);
    try {
      assertQuota(decision);
    } catch (error) {
      expect((error as QuotaExceededError).decision).toBe(decision);
      expect((error as Error).message).toContain("Quota exceeded for 7TIN/gh-lab");
    }
  });

  test("formatQuotaUsage shows usage and limits", () => {
    const decision = evaluateQuota({
      repo: REPO,
      now: NOW,
      branches: [branch("preview/7tin-gh-lab-pr-1")],
      events: [],
      limits: {
        maxBranches: 3,
        maxStorageDeltaBytes: 10 * 1024 * 1024,
        maxSandboxMinutesPerDay: 1,
        maxCreatesPerHour: 4,
      },
    });
    const text = formatQuotaUsage(decision);
    expect(text).toContain("1/3 branches");
    expect(text).toContain("0s/60s sandbox");
    expect(text).toContain("0/4 creates/h");
  });
});
