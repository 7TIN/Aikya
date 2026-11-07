import { describe, expect, test } from "bun:test";
import { PREVIEW_COMMENT_MARKER, renderPreviewComment } from "./comment.ts";
import type { PreviewResult } from "./preview.ts";

function result(overrides: Partial<PreviewResult> = {}): PreviewResult {
  return {
    pr: 123,
    event: "opened",
    action: "create",
    status: "ready",
    branch: "preview/pr-123",
    parent: "main",
    expiresAt: "2026-11-10T00:00:00.000Z",
    reason: "create a fresh preview branch for the pull request",
    steps: [],
    comment: "",
    ...overrides,
  };
}

describe("renderPreviewComment", () => {
  test("starts with the sticky marker and includes branch details", () => {
    const comment = renderPreviewComment(result());

    expect(comment.startsWith(PREVIEW_COMMENT_MARKER)).toBe(true);
    expect(comment).toContain("preview ready");
    expect(comment).toContain("preview/pr-123");
    expect(comment).toContain("main");
    expect(comment).toContain("2026-11-10T00:00:00.000Z");
  });

  test("renders tests and schema changes when a report exists", () => {
    const comment = renderPreviewComment(
      result({
        tests: {
          ran: true,
          exitCode: 0,
          passed: 12,
          failed: 0,
          durationMs: 100,
          outputTail: "",
        },
        report: {
          mode: "neon",
          branch: { name: "preview/pr-123" },
          parent: { name: "main" },
          base: {
            database: "neondb",
            serverVersion: "17",
            sizeBytes: 100,
            totalRows: 10,
            tables: [],
            writes: { inserts: 0, updates: 0, deletes: 0, hotUpdates: 0 },
            capturedAt: "2026-11-03T00:00:00.000Z",
          },
          compare: {
            database: "neondb",
            serverVersion: "17",
            sizeBytes: 200,
            totalRows: 12,
            tables: [],
            writes: { inserts: 2, updates: 0, deletes: 0, hotUpdates: 0 },
            capturedAt: "2026-11-03T00:00:00.000Z",
          },
          sizeDeltaBytes: 100,
          rowDelta: 2,
          branchWrites: { inserts: 2, updates: 0, deletes: 0, hotUpdates: 0 },
          tables: [],
          schemaDiff: {
            tablesAdded: ["coupons"],
            tablesRemoved: [],
            tablesChanged: [],
            enumsAdded: [],
            enumsRemoved: [],
            enumsChanged: [],
            hasChanges: true,
          },
          neonSchemaDiff: null,
          capturedAt: "2026-11-03T00:00:00.000Z",
        },
      }),
    );

    expect(comment).toContain("12 passed, 0 failed");
    expect(comment).toContain("+ table coupons");
  });

  test("renders advisory reviewer findings without changing the status", () => {
    const comment = renderPreviewComment(
      result({
        review: {
          ran: true,
          status: "failed",
          appUrl: "https://preview.example.test",
          appPort: 3000,
          findings: [
            { kind: "http", title: "GET /health", status: "failed", detail: "HTTP 500", evidence: "boom" },
            { kind: "db", title: "Read preview schema (tables)", status: "ok" },
          ],
          durationMs: 1000,
          budget: { timeoutMs: 90_000, maxOutputChars: 5_000 },
        },
      }),
    );

    expect(comment).toContain("preview ready");
    expect(comment).toContain("Advisory reviewer");
    expect(comment).toContain("does not affect the check outcome");
    expect(comment).toContain("GET /health");
    expect(comment).toContain("HTTP 500");
  });

  test("explains why a fork PR is skipped", () => {
    const comment = renderPreviewComment(
      result({
        status: "skipped",
        action: "skip",
        reason: "fork pull requests do not receive repository secrets",
      }),
    );

    expect(comment).toContain("preview skipped");
    expect(comment).toContain("pull_request_target");
    expect(comment).toContain("No database branch was created");
  });

  test("includes failure output in a collapsible block", () => {
    const comment = renderPreviewComment(
      result({
        status: "failed",
        error: "migration failed",
        steps: [
          {
            name: "migrate",
            status: "failed",
            detail: "relation already exists",
          },
        ],
      }),
    );

    expect(comment).toContain("preview failed");
    expect(comment).toContain("migration failed");
    expect(comment).toContain("relation already exists");
    expect(comment).toContain("<details>");
  });
});
