import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventLog, normalizeEvent } from "./log.ts";

const roots: string[] = [];

async function tempPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "aikya-events-test-"));
  roots.push(root);
  return join(root, "events.jsonl");
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("EventLog", () => {
  test("appends and loads events newest first", async () => {
    const path = await tempPath();
    const log = createEventLog(path);

    const first = await log.append({
      type: "branch.created",
      repo: "7TIN/gh-lab",
      pr: 3,
      branch: "preview/7tin-gh-lab-pr-3",
      status: "created",
      now: Date.parse("2026-11-10T10:00:00Z"),
    });
    const second = await log.append({
      type: "branch.report",
      repo: "7TIN/gh-lab",
      pr: 3,
      branch: "preview/7tin-gh-lab-pr-3",
      status: "ok",
      now: Date.parse("2026-11-10T10:00:05Z"),
    });

    expect(first.id).not.toBe(second.id);

    const events = await log.load();
    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe("branch.report");
    expect(events[1]?.type).toBe("branch.created");
  });

  test("filters by repo, branch, and since", async () => {
    const path = await tempPath();
    const log = createEventLog(path);

    await log.append({ type: "branch.created", repo: "a/one", branch: "preview/a-one-pr-1", now: 1_000 });
    await log.append({ type: "branch.created", repo: "b/two", branch: "preview/b-two-pr-2", now: 2_000 });
    await log.append({ type: "branch.deleted", repo: "a/one", branch: "preview/a-one-pr-1", now: 3_000 });

    expect((await log.load({ repo: "a/one" })).map((e) => e.type)).toEqual([
      "branch.deleted",
      "branch.created",
    ]);
    expect((await log.load({ branch: "preview/b-two-pr-2" })).map((e) => e.repo)).toEqual(["b/two"]);
    expect((await log.load({ since: new Date(2_500).toISOString() })).map((e) => e.type)).toEqual([
      "branch.deleted",
    ]);
  });

  test("skips malformed lines without throwing", async () => {
    const path = await tempPath();
    const log = createEventLog(path);

    await log.append({ type: "sync.started", repo: "7TIN/gh-lab" });
    const { appendFile } = await import("node:fs/promises");
    await appendFile(path, "not json\n", "utf8");
    await appendFile(path, JSON.stringify({ type: "bogus", at: "2026-11-10T00:00:00Z" }) + "\n", "utf8");

    const events = await log.load();
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("sync.started");
  });

  test("returns an empty log when the file is missing", async () => {
    const log = createEventLog(join(tmpdir(), "aikya-missing-events", "events.jsonl"));
    expect(await log.load()).toEqual([]);
  });

  test("normalizeEvent rejects unknown types", () => {
    expect(normalizeEvent({ type: "unknown", at: "2026-11-10T00:00:00Z" })).toBeNull();
    expect(normalizeEvent({ type: "branch.created", at: "2026-11-10T00:00:00Z" })?.type).toBe(
      "branch.created",
    );
  });
});
