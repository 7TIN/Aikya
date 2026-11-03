import { describe, expect, test } from "bun:test";
import { commandTail, parseTestSummary, type CommandResult } from "./run.ts";

describe("parseTestSummary", () => {
  test("parses bun test output", () => {
    const output = [
      "bun test v1.4.3",
      " 10 pass",
      " 0 fail",
      " 27 expect() calls",
    ].join("\n");

    expect(parseTestSummary(output)).toEqual({ passed: 10, failed: 0 });
  });

  test("returns null when the summary is missing", () => {
    expect(parseTestSummary("no summary here")).toEqual({
      passed: null,
      failed: null,
    });
  });

  test("uses the last summary when output is nested", () => {
    const output = ["3 pass", "1 fail", "7 pass", "2 fail"].join("\n");
    expect(parseTestSummary(output)).toEqual({ passed: 7, failed: 2 });
  });
});

describe("commandTail", () => {
  test("keeps the last non-empty lines", () => {
    const result: CommandResult = {
      command: "bun test",
      exitCode: 1,
      stdout: "line 1\nline 2\n",
      stderr: "boom",
      durationMs: 1,
    };

    expect(commandTail(result, 2)).toBe("line 1\nline 2");
    expect(commandTail(result, 3)).toBe("boom\nline 1\nline 2");
  });

  test("returns an empty string for empty output", () => {
    const result: CommandResult = {
      command: "true",
      exitCode: 0,
      stdout: "",
      stderr: "",
      durationMs: 1,
    };

    expect(commandTail(result)).toBe("");
  });
});

describe("runCommand", () => {
  test("captures output and exit code", async () => {
    const { runCommand } = await import("./run.ts");
    const result = await runCommand([
      process.execPath,
      "-e",
      "console.log('hello'); console.error('oops'); process.exit(3)",
    ]);

    expect(result.exitCode).toBe(3);
    expect(result.stdout.trim()).toBe("hello");
    expect(result.stderr.trim()).toBe("oops");
  });

  test("redacts secrets from output", async () => {
    const { runCommand } = await import("./run.ts");
    const secret = "postgres://user:pass@example/db";
    const result = await runCommand(
      [process.execPath, "-e", `console.log(${JSON.stringify(secret)})`],
      { secrets: [secret] },
    );

    expect(result.stdout.trim()).toBe("***");
  });

  test("passes a branch-scoped env to the child", async () => {
    const { runCommand } = await import("./run.ts");
    const result = await runCommand(
      [process.execPath, "-e", "console.log(process.env.DATABASE_URL)"],
      { env: { DATABASE_URL: "postgres://branch/test" } },
    );

    expect(result.stdout.trim()).toBe("postgres://branch/test");
  });
});
