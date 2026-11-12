import { describe, expect, test } from "bun:test";
import { createToolContext, executeTool } from "./tools.ts";
import type { QaCommandResult, QaSandbox } from "./types.ts";

class FakeSandbox implements QaSandbox {
  readonly kind = "local" as const;
  readonly name = "fake";
  readonly root = "/repo";
  readonly files = new Map<string, string>();
  readonly commands: string[] = [];

  async run(command: string): Promise<QaCommandResult> {
    this.commands.push(command);
    return {
      command,
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      timedOut: false,
      cancelled: false,
      durationMs: 1,
    };
  }
  async read(path: string): Promise<string> {
    return this.files.get(path) ?? "";
  }
  async write(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }
  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }
  async list(path = ""): Promise<string[]> {
    return [...this.files.keys()].filter(
      (file) => !path || file.startsWith(`${path}/`),
    );
  }
  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }
  async diff(): Promise<string> {
    return "";
  }
  async close(): Promise<void> {}
}

describe("executeTool", () => {
  test("allows an empty file", async () => {
    const sandbox = new FakeSandbox();
    const context = createToolContext(sandbox);

    const result = await executeTool(
      "write_file",
      { path: "src/empty.ts", content: "" },
      context,
    );

    expect(result.ok).toBe(true);
    expect(sandbox.files.get("src/empty.ts")).toBe("");
    expect(context.changed.has("src/empty.ts")).toBe(true);
  });

  test("rejects dotenv writes and unsafe commands", async () => {
    const sandbox = new FakeSandbox();
    const context = createToolContext(sandbox);

    const dotenv = await executeTool(
      "write_file",
      { path: ".env", content: "SECRET=1" },
      context,
    );
    expect(dotenv.ok).toBe(false);
    expect(dotenv.output).toContain("dotenv");

    const command = await executeTool(
      "run_command",
      { command: "git push" },
      context,
    );
    expect(command.ok).toBe(false);
    expect(sandbox.commands).toEqual([]);
  });

  test("enforces the write budget", async () => {
    const sandbox = new FakeSandbox();
    const context = createToolContext(sandbox, { maxFileBytes: 10 });

    const result = await executeTool(
      "write_file",
      { path: "src/big.ts", content: "0123456789A" },
      context,
    );

    expect(result.ok).toBe(false);
    expect(result.output).toContain("budget");
    expect(sandbox.files.has("src/big.ts")).toBe(false);
  });

  test("returns an error for unknown tools", async () => {
    const sandbox = new FakeSandbox();
    const result = await executeTool("nope", {}, createToolContext(sandbox));
    expect(result.ok).toBe(false);
    expect(result.output).toContain("unknown tool");
  });
});
