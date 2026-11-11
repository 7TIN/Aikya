import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventLog } from "../events/log.ts";
import type { NeonBranch } from "./branches.ts";
import { runReaper } from "./reaper.ts";

const NOW = Date.parse("2026-11-12T12:00:00.000Z");
const roots: string[] = [];

async function eventLogPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "aikya-reaper-test-"));
  roots.push(root);
  return join(root, "events.jsonl");
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

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

function oldBranch(name: string): NeonBranch {
  return branch(name, {
    createdAt: new Date(NOW - 10 * 24 * 60 * 60 * 1_000).toISOString(),
  });
}

describe("runReaper", () => {
  test("dry run selects expired and stale previews but deletes nothing", async () => {
    const events = createEventLog(await eventLogPath());
    const deleted: string[] = [];

    const report = await runReaper({
      parentName: "main",
      protectedNames: ["staging", "qa"],
      now: NOW,
      deps: {
        events,
        list: async () => [
          oldBranch("preview/7tin-gh-lab-pr-1"),
          branch("preview/7tin-gh-lab-pr-2", {
            expiresAt: new Date(NOW - 60_000).toISOString(),
          }),
          branch("preview/7tin-gh-lab-pr-3"),
        ],
        delete: async (name) => {
          deleted.push(name);
        },
      },
    });

    expect(report.mode).toBe("dry-run");
    expect(deleted).toEqual([]);
    expect(report.candidates.map((candidate) => candidate.name).sort()).toEqual([
      "preview/7tin-gh-lab-pr-1",
      "preview/7tin-gh-lab-pr-2",
    ]);
    expect(report.deleted).toEqual([]);

    const logged = await events.recent();
    expect(logged[0]?.type).toBe("reap.completed");
    expect(logged[0]?.status).toBe("dry-run");
    expect(logged[0]?.detail?.candidates).toHaveLength(2);
  });

  test("deletes matching previews and logs each deletion", async () => {
    const events = createEventLog(await eventLogPath());
    const deleted: string[] = [];

    const report = await runReaper({
      repo: "7TIN/gh-lab",
      parentName: "main",
      protectedNames: ["staging", "qa"],
      dryRun: false,
      now: NOW,
      deps: {
        events,
        list: async () => [
          oldBranch("preview/7tin-gh-lab-pr-1"),
          branch("preview/7tin-gh-lab-pr-2", {
            expiresAt: new Date(NOW - 60_000).toISOString(),
          }),
          oldBranch("ad-hoc-branch"),
          oldBranch("staging"),
          branch("main", { default: true, primary: true }),
        ],
        delete: async (name) => {
          deleted.push(name);
        },
      },
    });

    expect(report.mode).toBe("delete");
    expect(deleted.sort()).toEqual([
      "preview/7tin-gh-lab-pr-1",
      "preview/7tin-gh-lab-pr-2",
    ]);
    expect(report.deleted).toHaveLength(2);
    expect(report.failed).toEqual([]);

    const logged = await events.recent();
    expect(logged[0]?.type).toBe("reap.completed");
    expect(logged[0]?.status).toBe("ok");
    expect(logged[0]?.repo).toBe("7TIN/gh-lab");
    expect(logged.filter((event) => event.type === "branch.deleted")).toHaveLength(2);
    expect(
      logged.find((event) => event.type === "branch.deleted")?.reason,
    ).toMatch(/^reaper:(age|expired)$/);
  });

  test("records a failed deletion and marks the run failed", async () => {
    const events = createEventLog(await eventLogPath());

    const report = await runReaper({
      parentName: "main",
      dryRun: false,
      now: NOW,
      deps: {
        events,
        list: async () => [oldBranch("preview/7tin-gh-lab-pr-1")],
        delete: async () => {
          throw new Error("Neon refused");
        },
      },
    });

    expect(report.deleted).toEqual([]);
    expect(report.failed).toEqual([
      { branch: "preview/7tin-gh-lab-pr-1", error: "Neon refused" },
    ]);

    const logged = await events.recent();
    expect(logged[0]?.type).toBe("reap.completed");
    expect(logged[0]?.status).toBe("failed");
  });

  test("honours a custom prefix and age threshold", async () => {
    const events = createEventLog(await eventLogPath());

    const report = await runReaper({
      parentName: "main",
      prefix: "preview/a-",
      olderThanMs: 2 * 24 * 60 * 60 * 1_000,
      now: NOW,
      deps: {
        events,
        list: async () => [
          branch("preview/a-pr-1", {
            createdAt: new Date(NOW - 3 * 24 * 60 * 60 * 1_000).toISOString(),
          }),
          oldBranch("preview/b-pr-1"),
        ],
        delete: async () => undefined,
      },
    });

    expect(report.candidates.map((candidate) => candidate.name)).toEqual([
      "preview/a-pr-1",
    ]);
  });
});
