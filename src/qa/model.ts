/**
 * A tiny OpenAI-compatible chat client. No SDK, no streaming, no retries —
 * the QA loop is bounded, so a failed request should surface immediately.
 */

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ModelReply {
  content: string | null;
  toolCalls: ToolCall[];
  promptTokens: number | null;
  completionTokens: number | null;
}

export interface ModelClient {
  readonly model: string;
  complete(input: {
    messages: ChatMessage[];
    tools: ToolDefinition[];
    signal?: AbortSignal;
  }): Promise<ModelReply>;
}

export interface OpenAiModelOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  fetchImpl?: typeof fetch;
}

export class QaModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QaModelError";
  }
}

function firstString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function firstNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseToolCalls(raw: unknown): ToolCall[] {
  if (!Array.isArray(raw)) return [];
  const calls: ToolCall[] = [];

  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const value = item as Record<string, unknown>;
    const fn = value.function;
    if (typeof fn !== "object" || fn === null) continue;
    const call = fn as Record<string, unknown>;
    const name = firstString(call.name);
    if (!name) continue;

    calls.push({
      id: firstString(value.id) ?? `call_${calls.length}`,
      type: "function",
      function: {
        name,
        arguments:
          typeof call.arguments === "string"
            ? call.arguments
            : JSON.stringify(call.arguments ?? {}),
      },
    });
  }

  return calls;
}

export function createOpenAiModel(options: OpenAiModelOptions = {}): ModelClient {
  const apiKey =
    options.apiKey ?? process.env.AIKYA_QA_API_KEY ?? process.env.OPENAI_API_KEY;
  const baseUrl = (
    options.baseUrl ??
    process.env.AIKYA_QA_BASE_URL ??
    "https://api.openai.com/v1"
  ).replace(/\/$/, "");
  const model = options.model ?? process.env.AIKYA_QA_MODEL ?? "gpt-4.1-mini";
  const fetchImpl = options.fetchImpl ?? fetch;

  if (!apiKey) {
    throw new QaModelError(
      "No model API key. Set AIKYA_QA_API_KEY (or OPENAI_API_KEY), " +
        "or run `bun run qa` without --agent for deterministic checks.",
    );
  }

  return {
    model,
    async complete(input) {
      const response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: input.messages,
          tools: input.tools,
          tool_choice: "auto",
        }),
        signal: input.signal,
      });

      const body = await response.text();
      if (!response.ok) {
        throw new QaModelError(
          `model request failed (${response.status}): ${body.slice(0, 600)}`,
        );
      }

      let data: unknown;
      try {
        data = JSON.parse(body);
      } catch {
        throw new QaModelError("model returned non-JSON output");
      }

      if (typeof data !== "object" || data === null) {
        throw new QaModelError("model returned an empty response");
      }

      const root = data as Record<string, unknown>;
      const choices = Array.isArray(root.choices) ? root.choices : [];
      const choice = choices[0];
      const message =
        typeof choice === "object" && choice !== null
          ? (choice as Record<string, unknown>).message
          : null;

      if (typeof message !== "object" || message === null) {
        throw new QaModelError("model response has no message");
      }

      const value = message as Record<string, unknown>;
      const usage =
        typeof root.usage === "object" && root.usage !== null
          ? (root.usage as Record<string, unknown>)
          : {};

      return {
        content: firstString(value.content),
        toolCalls: parseToolCalls(value.tool_calls),
        promptTokens: firstNumber(usage.prompt_tokens),
        completionTokens: firstNumber(usage.completion_tokens),
      };
    },
  };
}
