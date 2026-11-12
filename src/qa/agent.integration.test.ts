import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runQaAgent } from "./agent.ts";
import type { ModelClient, ToolCall } from "./model.ts";
import { LocalQaSandbox } from "./sandbox.ts";
import type { QaSandbox } from "./types.ts";

/**
 * Integration proof for the repair loop: a real temp checkout, a genuinely
 * failing test, a scripted "model" that behaves like a careful engineer, and
 * the real allowlisted command runner. No API key and no network.
 */

const roots: string[] = [];
const hasGit = Bun.which("git") !== null;

async function brokenRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "aikya-qa-repair-"));
  roots.push(root);

  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "qa-repair-fixture", private: true, type: "module" }),
    "utf8",
  );
  await writeFile(
    join(root, "src/math.ts"),
    "export function add(a: number, b: number): number {\n  return a - b;\n}\n",
    "utf8",
  );
  await writeFile(
    join(root, "src/math.test.ts"),
    [
      'import { expect, test } from "bun:test";',
      'import { add } from "./math.ts";',
      "",
      'test("adds", () => {',
      "  expect(add(1, 2)).toBe(3);",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );

  return root;
}

function call(name: string, args: Record<string, unknown>, id = name): ToolCall {
  return {
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("QA repair loop (integration)", () => {
  test.skipIf(!hasGit)(
    "finds a real failing test, patches the source, and proves it passes",
    async () => {
      const source = await brokenRepo();
      const sandbox: QaSandbox = await LocalQaSandbox.create({
        source,
        install: false,
      });

      try {
        const failing = await sandbox.run("bun test src/math.test.ts", {
          timeoutMs: 120_000,
        });
        expect(failing.exitCode).not.toBe(0);

        const replies = [
          { toolCalls: [call("read_file", { path: "src/math.ts" }, "c1")] },
          {
            toolCalls: [
              call(
                "write_file",
                {
                  path: "src/math.ts",
                  content:
                    "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
                },
                "c2",
              ),
            ],
          },
          {
            toolCalls: [
              call("run_command", { command: "bun test src/math.test.ts" }, "c3"),
            ],
          },
          {
            toolCalls: [
              call(
                "done",
                { status: "fixed", summary: "add() subtracted instead of adding" },
                "c4",
              ),
            ],
          },
        ];

        const model: ModelClient = {
          model: "scripted",
          async complete() {
            const reply = replies.shift();
            if (!reply) throw new Error("scripted model exhausted");
            return {
              content: null,
              toolCalls: reply.toolCalls,
              promptTokens: 1,
              completionTokens: 1,
            };
          },
        };

        const result = await runQaAgent({
          sandbox,
          model,
          checks: [],
          maxSteps: 8,
        });

        expect(result.status).toBe("fixed");
        expect(result.filesChanged).toEqual(["src/math.ts"]);
        expect(result.patch).toContain("-  return a - b;");
        expect(result.patch).toContain("+  return a + b;");
        expect(result.steps.map((step) => step.tool)).toEqual([
          "read_file",
          "write_file",
          "run_command",
          "done",
        ]);
        expect(result.steps[2]?.ok).toBe(true);

        const passing = await sandbox.run("bun test src/math.test.ts", {
          timeoutMs: 120_000,
        });
        expect(passing.exitCode).toBe(0);
      } finally {
        await sandbox.close();
      }
    },
    120_000,
  );
});
