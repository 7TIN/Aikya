import { describe, expect, test } from "bun:test";
import type { NeonBranch } from "../neon/branches.ts";
import {
  mergePreviews,
  normalizePreviewArtifact,
  normalizePreviewStatus,
  previewNumberFromBranch,
  type PreviewRecord,
} from "./previews.ts";

function branch(overrides: Partial<NeonBranch> & { name: string }): NeonBranch {
  return {
    id: `br-${overrides.name}`,
    projectId: "test",
    default: false,
    primary: false,
    protected: false,
    currentState: "ready",
    stateChangedAt: "2026-11-03T10:00:00Z",
    createdAt: "2026-11-03T10:00:00Z",
    updatedAt: "2026-11-03T10:00:00Z",
    logicalSize: 0,
    writtenDataBytes: 0,
    cpuUsedSec: 0,
    computeTimeSeconds: 0,
    ...overrides,
    name: overrides.name,
  };
}

function record(overrides: Partial<PreviewRecord> = {}): PreviewRecord {
  return {
    pr: 7,
    branch: "preview/pr-7",
    parent: "main",
    event: "opened",
    action: "create",
    status: "ready",
    reason: "create a fresh preview branch for the pull request",
    expiresAt: "2026-11-10T10:00:00Z",
    updatedAt: "2026-11-03T10:00:00Z",
    artifactPath: "artifacts/preview/pr-7/report.json",
    steps: [],
    tests: null,
    report: null,
    comment: null,
    error: null,
    ...overrides,
  };
}

describe("preview artifacts", () => {
  test("parses a ready artifact with steps, tests, and report", () => {
    const parsed = normalizePreviewArtifact(
      {
        pr: 12,
        event: "opened",
        action: "create",
        branch: "preview/pr-12",
        parent: "main",
        status: "ready",
        reason: "create a fresh preview branch for the pull request",
        expiresAt: "2026-11-10T10:00:00Z",
        steps: [
          { name: "create branch", status: "ok", durationMs: 1200 },
          { name: "tests", status: "ok", detail: "42 passed" },
        ],
        tests: { ran: true, exitCode: 0, passed: 42, failed: 0 },
        report: {
          base: { totalRows: 72426 },
          compare: { totalRows: 72427 },
          rowDelta: 1,
          sizeDeltaBytes: 32768,
          schemaDiff: { hasChanges: true },
        },
      },
      { dirName: "pr-12", updatedAt: "2026-11-03T10:00:00Z" },
    );

    expect(parsed.pr).toBe(12);
    expect(parsed.branch).toBe("preview/pr-12");
    expect(parsed.status).toBe("ready");
    expect(parsed.steps).toHaveLength(2);
    expect(parsed.tests).toEqual({ ran: true, exitCode: 0, passed: 42, failed: 0 });
    expect(parsed.report).toEqual({
      rowsBase: 72426,
      rowsBranch: 72427,
      rowDelta: 1,
      sizeDeltaBytes: 32768,
      schemaChanged: true,
    });
  });

  test("falls back to the directory name when pr and branch are missing", () => {
    const parsed = normalizePreviewArtifact(
      { status: "failed", error: "boom" },
      { dirName: "pr-99" },
    );

    expect(parsed.pr).toBe(99);
    expect(parsed.branch).toBe("preview/pr-99");
    expect(parsed.status).toBe("failed");
    expect(parsed.error).toBe("boom");
    expect(parsed.report).toBeNull();
  });

  test("normalizes unknown statuses instead of trusting them", () => {
    expect(normalizePreviewStatus("ready")).toBe("ready");
    expect(normalizePreviewStatus("weird")).toBe("unknown");
    expect(normalizePreviewStatus(undefined)).toBe("unknown");
  });

  test("extracts the PR number only from preview branches", () => {
    expect(previewNumberFromBranch("preview/pr-42")).toBe(42);
    expect(previewNumberFromBranch("preview/pr-42-hotfix")).toBeNull();
    expect(previewNumberFromBranch("main")).toBeNull();
  });
});

describe("mergePreviews", () => {
  test("joins artifacts with the live branch state", () => {
    const views = mergePreviews(
      [record()],
      [
        branch({
          name: "preview/pr-7",
          logicalSize: 44_000_000,
          writtenDataBytes: 0,
          expiresAt: "2026-11-10T10:00:00Z",
        }),
        branch({ name: "main", default: true, primary: true }),
      ],
    );

    expect(views).toHaveLength(1);
    expect(views[0]?.live.exists).toBe(true);
    expect(views[0]?.live.state).toBe("ready");
    expect(views[0]?.live.logicalSize).toBe(44_000_000);
    expect(views[0]?.status).toBe("ready");
  });

  test("shows preview branches that have no local artifact", () => {
    const views = mergePreviews(
      [],
      [
        branch({ name: "preview/pr-55" }),
        branch({ name: "preview/pr-56", currentState: "provisioning" }),
        branch({ name: "staging" }),
        branch({ name: "main", default: true }),
      ],
    );

    expect(views.map((view) => view.branch)).toEqual([
      "preview/pr-56",
      "preview/pr-55",
    ]);
    expect(views.every((view) => view.status === "branch-only")).toBe(true);
    expect(views[0]?.live.state).toBe("provisioning");
  });

  test("marks deleted artifacts as absent when the branch is gone", () => {
    const views = mergePreviews([record({ status: "deleted" })], []);
    expect(views[0]?.status).toBe("deleted");
    expect(views[0]?.live.exists).toBe(false);
  });

  test("sorts by artifact recency and leaves branch-only entries last", () => {
    const views = mergePreviews(
      [
        record({
          pr: 1,
          branch: "preview/pr-1",
          updatedAt: "2026-11-01T10:00:00Z",
        }),
        record({
          pr: 2,
          branch: "preview/pr-2",
          updatedAt: "2026-11-03T10:00:00Z",
        }),
      ],
      [branch({ name: "preview/pr-3" })],
    );

    expect(views.map((view) => view.branch)).toEqual([
      "preview/pr-2",
      "preview/pr-1",
      "preview/pr-3",
    ]);
  });

  test("keeps the newest record when artifacts are duplicated", () => {
    const views = mergePreviews(
      [
        record({ updatedAt: "2026-11-01T10:00:00Z", status: "failed" }),
        record({ updatedAt: "2026-11-02T10:00:00Z", status: "ready" }),
      ],
      [],
    );

    expect(views).toHaveLength(1);
    expect(views[0]?.status).toBe("ready");
  });
});
