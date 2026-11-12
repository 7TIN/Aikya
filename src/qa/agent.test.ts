import { describe, expect, test } from "bun:test";
import { patchFiles, runQaAgent } from "./agent.ts";
import type { ModelClient, ToolCall } from "./model.ts";
import type { QaCommandResult, QaSandbox } from "./types.ts";

class FakeSandbox implements QaSandbox {
  readonly kind = "local" as const;
  readonly name = "fake";
  readonly root = "/repo";
  readonly files = new Map<string, string>();
  readonly runs: string[] = [];
  private readonly baseline: Map<string, string>;

  constructor(files: Record<string, string> = {}) {
    for (const [path, content] of Object.entries(files)) {
      this.files.set(path, content);
    }
    this.baseline = new Map(this.files);
  }

  async run(command: string): Promise<QaCommandResult> {
    this.runs.push(command);
    return {
      command,
      exitCode: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
      cancelled: false,
      durationMs: 1,
    };
  }

  async read(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`not found: ${path}`);
    return content;
  }

  async write(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }

  async list(path = ""): Promise<string[]> {
    return [...this.files.keys()].filter(
      (file) => !path || file === path || file.startsWith(`${path}/`),
    );
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async diff(): Promise<string> {
    const changed = [...this.files.entries()].filter(
      ([path, content]) => this.baseline.get(path) !== content,
    );
    if (changed.length === 0) return "";
    return changed
      .map(
        ([path]) =>
          `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n`,
      )
      .join("");
  }

  async close(): Promise<void> {}
}

function call(name: string, args: Record<string, unknown>, id = name): ToolCall {
  return {
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

function scriptedModel(replies: Array<{
  content?: string | null;
  toolCalls?: ToolCall[];
}>): ModelClient {
  let index = 0;
  return {
    model: "fake-model",
    async complete() {
      const reply = replies[index];
      index += 1;
      if (!reply) throw new Error("scripted model exhausted");
      return {
        content: reply.content ?? null,
        toolCalls: reply.toolCalls ?? [],
        promptTokens: 10,
        completionTokens: 5,
      };
    },
  };
}

describe("runQaAgent", () => {
  test("reads, writes, verifies, and finishes with a patch", async () => {
    const sandbox = new FakeSandbox({ "src/a.ts": "export const a = 1;\n" });
    const model = scriptedModel([
      { toolCalls: [call("read_file", { path: "src/a.ts" }, "c1")] },
      {
        toolCalls: [
          call(
            "write_file",
            { path: "src/a.ts", content: "export const a = 2;\n" },
            "c2",
          ),
        ],
      },
      { toolCalls: [call("run_command", { command: "bun test" }, "c3")] },
      {
        toolCalls: [
          call("done", { status: "fixed", summary: "changed a" }, "c4"),
        ],
      },
    ]);

    const result = await runQaAgent({
      sandbox,
      model,
      checks: [],
      maxSteps: 8,
    });

    expect(result.status).toBe("fixed");
    expect(result.steps).toHaveLength(4);
    expect(result.steps[1]?.tool).toBe("write_file");
    expect(result.steps[1]?.input).toEqual({ path: "src/a.ts", bytes: 20 });
    expect(result.filesChanged).toEqual(["src/a.ts"]);
    expect(result.patch).toContain("diff --git a/src/a.ts b/src/a.ts");
    expect(result.summary).toBe("changed a");
    expect(result.usage.steps).toBe(4);
    expect(sandbox.runs).toEqual(["bun test"]);
  });

  test("stops at the step budget", async () => {
    const sandbox = new FakeSandbox({ "src/a.ts": "x" });
    const model = scriptedModel(
      Array.from({ length: 10 }, () => ({
        toolCalls: [call("list_files", {}, "c")],
      })),
    );

    const result = await runQaAgent({
      sandbox,
      model,
      checks: [],
      maxSteps: 2,
    });

    expect(result.status).toBe("failed");
    expect(result.reason).toContain("step budget exhausted");
    expect(result.steps).toHaveLength(2);
  });

  test("returns tool guard errors to the model without writing", async () => {
    const sandbox = new FakeSandbox({ "src/a.ts": "x" });
    const model = scriptedModel([
      {
        toolCalls: [
          call(
            "write_file",
            { path: "../escape.ts", content: "bad" },
            "c1",
          ),
        ],
      },
      { toolCalls: [call("done", { status: "ok", summary: "nothing" }, "c2")] },
    ]);

    const result = await runQaAgent({
      sandbox,
      model,
      checks: [],
      maxSteps: 4,
    });

    expect(result.steps[0]?.ok).toBe(false);
    expect(result.steps[0]?.output).toContain("error:");
    expect(result.filesChanged).toEqual([]);
    expect(sandbox.files.has("../escape.ts")).toBe(false);
    expect(result.status).toBe("ok");
  });

  test("reports failure from done", async () => {
    const sandbox = new FakeSandbox();
    const model = scriptedModel([
      {
        toolCalls: [
          call("done", { status: "failed", summary: "cannot reproduce" }, "c1"),
        ],
      },
    ]);

    const result = await runQaAgent({
      sandbox,
      model,
      checks: [],
      maxSteps: 3,
    });

    expect(result.status).toBe("failed");
    expect(result.reason).toBe("cannot reproduce");
  });

  test("treats a content-only reply as a finished run", async () => {
    const sandbox = new FakeSandbox();
    const model = scriptedModel([{ content: "all checks pass" }]);

    const result = await runQaAgent({
      sandbox,
      model,
      checks: [],
      maxSteps: 3,
    });

    expect(result.status).toBe("ok");
    expect(result.summary).toBe("all checks pass");
  });

  test("returns an error status when the model fails", async () => {
    const sandbox = new FakeSandbox();
    const model: ModelClient = {
      model: "fake",
      async complete() {
        throw new Error("upstream 500");
      },
    };

    const result = await runQaAgent({
      sandbox,
      model,
      checks: [],
      maxSteps: 3,
    });

    expect(result.status).toBe("error");
    expect(result.reason).toBe("upstream 500");
  });
});

describe("patchFiles", () => {
  test("extracts changed paths", () => {
    const patch = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "diff --git a/docs/b.md b/docs/b.md",
    ].join("\n");
    expect(patchFiles(patch)).toEqual(["docs/b.md", "src/a.ts"]);
  });

  test("ignores non-patch text", () => {
    expect(patchFiles("")).toEqual([]);
  });
});
