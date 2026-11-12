import { describe, expect, test } from "bun:test";
import { runQaChecks } from "./checks.ts";
import type { QaCommandResult, QaSandbox } from "./types.ts";

class FakeSandbox implements QaSandbox {
  readonly kind = "local" as const;
  readonly name = "fake";
  readonly root = "/repo";
  readonly commands: string[] = [];

  constructor(private readonly exitCodes: Record<string, number>) {}

  async run(command: string): Promise<QaCommandResult> {
    this.commands.push(command);
    const exitCode = this.exitCodes[command] ?? 0;
    return {
      command,
      exitCode,
      stdout: exitCode === 0 ? "ok" : "",
      stderr: exitCode === 0 ? "" : `failed: ${command}`,
      timedOut: false,
      cancelled: false,
      durationMs: 5,
    };
  }

  async read(): Promise<string> {
    return "";
  }
  async write(): Promise<void> {}
  async remove(): Promise<void> {}
  async list(): Promise<string[]> {
    return [];
  }
  async exists(): Promise<boolean> {
    return false;
  }
  async diff(): Promise<string> {
    return "";
  }
  async close(): Promise<void> {}
}

describe("runQaChecks", () => {
  test("runs every check and records failures", async () => {
    const sandbox = new FakeSandbox({ "bun run build": 1 });
    const results = await runQaChecks(sandbox);

    expect(results.map((check) => check.name)).toEqual([
      "typecheck",
      "test",
      "build",
    ]);
    expect(results.map((check) => check.status)).toEqual([
      "ok",
      "ok",
      "failed",
    ]);
    expect(results[2]?.exitCode).toBe(1);
    expect(results[2]?.output).toContain("failed");
    expect(sandbox.commands).toHaveLength(3);
  });

  test("marks checks skipped after cancellation", async () => {
    const sandbox = new FakeSandbox({});
    const controller = new AbortController();
    controller.abort();

    const results = await runQaChecks(sandbox, { signal: controller.signal });

    expect(results.every((check) => check.status === "skipped")).toBe(true);
    expect(sandbox.commands).toEqual([]);
  });
});
