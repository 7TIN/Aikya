import type { ModelClient, ChatMessage } from "./model.ts";
import { QA_TOOLS, createToolContext, executeTool, parseToolArguments } from "./tools.ts";
import type {
  QaCheckResult,
  QaRunStatus,
  QaSandbox,
  QaStep,
  QaUsage,
} from "./types.ts";

/**
 * The bounded QA loop.
 *
 * One model call per step, at most one batch of tool calls per step, a hard
 * wall-clock budget, and a hard write budget. The model never talks to Neon,
 * GitHub, Vercel, or the host shell directly — only to `executeTool`.
 */

const DEFAULT_MAX_STEPS = 12;
const DEFAULT_MAX_WALL_MS = 8 * 60_000;

export interface QaAgentOptions {
  sandbox: QaSandbox;
  model: ModelClient;
  checks: QaCheckResult[];
  maxSteps?: number;
  maxWallMs?: number;
  maxFileBytes?: number;
  maxOutputChars?: number;
  maxSearchFiles?: number;
  signal?: AbortSignal;
  log?: (line: string) => void;
}

export interface QaAgentResult {
  status: QaRunStatus;
  reason: string | null;
  summary: string | null;
  steps: QaStep[];
  patch: string;
  filesChanged: string[];
  usage: QaUsage;
}

const SYSTEM_PROMPT = `You are Aikya QA, a small autonomous test-and-fix agent.

Aikya is a Bun/TypeScript service that watches GitHub pull requests, creates a
Neon Postgres preview branch per PR, runs the PR contract in a sandbox, and
serves a localhost dashboard.

Your job: verify the repository, find a real defect, fix it with the smallest
possible change, and prove the fix. Work like a careful engineer, not a
rewriter.

Rules:
- Read the failing output before editing anything.
- Use tools to inspect the code. Never guess a file's contents.
- Prefer a focused test that reproduces the defect.
- Make the smallest change that fixes the root cause.
- Run the smallest relevant check first, then the full suite.
- Do not add dependencies, change lockfiles, or touch dotenv files.
- Do not commit, push, tag, deploy, or call cloud/GitHub CLIs.
- Never print or copy secrets.
- If every preflight check passes, look for one concrete gap in coverage or a
  guardrail bug, add a focused test if useful, then stop.
- Call the \`done\` tool exactly once. Status is:
  - "ok" when nothing needed changing,
  - "fixed" when the patch is ready,
  - "failed" when you cannot fix the defect.
`;

function summarizeInput(
  name: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (name === "write_file") {
    const content = typeof args.content === "string" ? args.content : "";
    return {
      path: args.path,
      bytes: Buffer.byteLength(content, "utf8"),
    };
  }
  if (name === "read_file" || name === "list_files" || name === "delete_file") {
    return { path: args.path };
  }
  if (name === "run_command") {
    return { command: args.command, timeoutMs: args.timeoutMs };
  }
  if (name === "search") {
    return { query: args.query, path: args.path };
  }
  if (name === "done") {
    return { status: args.status };
  }
  return args;
}

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n… [truncated]` : text;
}

function checkSummary(checks: QaCheckResult[]): string {
  if (checks.length === 0) return "No deterministic checks were run.";
  return checks
    .map((check) => {
      const detail =
        check.status === "failed"
          ? `\n### ${check.name} failed (exit ${check.exitCode ?? "?"})\n${truncate(check.output, 12_000)}`
          : "";
      return `- ${check.name}: ${check.status} (${check.durationMs}ms)${detail}`;
    })
    .join("\n");
}

function initialPrompt(checks: QaCheckResult[]): string {
  const failed = checks.filter((check) => check.status === "failed");
  const focus =
    checks.length === 0
      ? "No deterministic checks were run. Run the relevant checks yourself before editing."
      : failed.length > 0
        ? `The failing checks are: ${failed.map((check) => check.name).join(", ")}. ` +
          "Start with the smallest reproducer for the first failure."
        : "Every preflight check passed. Look for one concrete coverage or guardrail gap, " +
          "add a focused test only if it proves a real defect, then finish with status ok " +
          "unless you produced a patch.";

  return `Run the Aikya QA pass in this checkout.

Preflight:
${checkSummary(checks)}

${focus}

Use list_files/read_file/search to inspect the code, write_file to patch it, and
run_command to verify. Finish by calling the \`done\` tool.`;
}

export function patchFiles(patch: string): string[] {
  const files = new Set<string>();
  for (const line of patch.split(/\r?\n/)) {
    const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (match?.[2]) files.add(match[2]);
  }
  return [...files].sort();
}

function normalizeDoneStatus(
  raw: unknown,
  hasPatch: boolean,
): QaRunStatus {
  if (raw === "failed") return "failed";
  if (raw === "fixed") return hasPatch ? "fixed" : "ok";
  return "ok";
}

export async function runQaAgent(options: QaAgentOptions): Promise<QaAgentResult> {
  const log = options.log ?? (() => {});
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const maxWallMs = options.maxWallMs ?? DEFAULT_MAX_WALL_MS;
  const startedAt = Date.now();

  const context = createToolContext(options.sandbox, {
    maxOutputChars: options.maxOutputChars,
    maxFileBytes: options.maxFileBytes,
    maxSearchFiles: options.maxSearchFiles,
  });

  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: initialPrompt(options.checks) },
  ];

  const steps: QaStep[] = [];
  let promptTokens = 0;
  let completionTokens = 0;
  let status: QaRunStatus = "failed";
  let summary: string | null = null;
  let reason: string | null = null;
  let finished = false;

  try {
    outer: for (let index = 1; index <= maxSteps; index += 1) {
      if (options.signal?.aborted) {
        reason = "cancelled";
        break;
      }
      if (Date.now() - startedAt > maxWallMs) {
        reason = "wall-clock budget exhausted";
        break;
      }

      const reply = await options.model.complete({
        messages,
        tools: QA_TOOLS,
        signal: options.signal,
      });
      promptTokens += reply.promptTokens ?? 0;
      completionTokens += reply.completionTokens ?? 0;

      const assistant: ChatMessage = {
        role: "assistant",
        content: reply.content,
      };
      if (reply.toolCalls.length > 0) assistant.tool_calls = reply.toolCalls;
      messages.push(assistant);

      if (reply.toolCalls.length === 0) {
        summary = reply.content?.trim() || null;
        const patch = await options.sandbox.diff();
        status = patch.trim() ? "fixed" : "ok";
        finished = true;
        break;
      }

      for (const call of reply.toolCalls) {
        const stepStartedAt = Date.now();
        let args: Record<string, unknown> = {};
        let result: Awaited<ReturnType<typeof executeTool>>;
        try {
          args = parseToolArguments(call.function.arguments);
          result = await executeTool(call.function.name, args, context);
        } catch (error) {
          result = {
            ok: false,
            output: `error: ${error instanceof Error ? error.message : String(error)}`,
            filesChanged: [],
          };
        }

        const step: QaStep = {
          index: steps.length + 1,
          at: new Date().toISOString(),
          tool: call.function.name,
          input: summarizeInput(call.function.name, args),
          ok: result.ok,
          summary: result.output.split(/\r?\n/)[0]?.slice(0, 240) ?? "",
          durationMs: Math.max(0, Date.now() - stepStartedAt),
          output: truncate(result.output, 4_000),
        };
        steps.push(step);
        log(
          `[qa] ${step.index}. ${step.tool} ${step.ok ? "ok" : "failed"} · ${step.summary}`,
        );

        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: result.output,
        });

        if (call.function.name === "done") {
          summary = typeof args.summary === "string" ? args.summary.trim() : null;
          const patch = await options.sandbox.diff();
          status = normalizeDoneStatus(args.status, patch.trim().length > 0);
          if (status === "failed") {
            reason = summary || "agent reported failure";
          }
          finished = true;
          break outer;
        }
      }
    }
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
    status = "error";
    finished = true;
  }

  if (!finished) {
    reason ??= `step budget exhausted after ${maxSteps} steps`;
    status = "failed";
  }

  const patch = await options.sandbox.diff();
  const filesChanged = patchFiles(patch);

  return {
    status,
    reason,
    summary,
    steps,
    patch,
    filesChanged,
    usage: {
      steps: steps.length,
      promptTokens: promptTokens || null,
      completionTokens: completionTokens || null,
    },
  };
}
