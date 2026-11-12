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
  /** Provider used for this client, when known. */
  readonly provider?: QaProvider;
  complete(input: {
    messages: ChatMessage[];
    tools: ToolDefinition[];
    signal?: AbortSignal;
  }): Promise<ModelReply>;
}

export type QaProvider = "openai" | "gemini";

export interface OpenAiModelOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  provider?: QaProvider;
  fetchImpl?: typeof fetch;
}

export const GEMINI_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta/openai";
export const OPENAI_BASE_URL = "https://api.openai.com/v1";

/** Free-tier friendly defaults. Override with AIKYA_QA_MODEL. */
export const DEFAULT_QA_MODELS: Record<QaProvider, string> = {
  gemini: "gemini-3.8-flash",
  openai: "gpt-4.1-mini",
};

/**
 * Pick a provider without guessing when both keys are present:
 * explicit AIKYA_QA_PROVIDER wins, then a Gemini base URL, then a Gemini key,
 * then OpenAI. `AIKYA_QA_API_KEY` alone does not imply a provider.
 */
export function resolveQaProvider(
  env: Record<string, string | undefined> = process.env,
): QaProvider {
  const explicit = env.AIKYA_QA_PROVIDER?.trim().toLowerCase();
  if (explicit === "gemini" || explicit === "openai") return explicit;

  const base = env.AIKYA_QA_BASE_URL ?? "";
  if (/googleapis\.com/i.test(base)) return "gemini";
  if (env.GEMINI_API_KEY || env.GOOGLE_API_KEY) return "gemini";
  return "openai";
}

function providerKey(
  provider: QaProvider,
  env: Record<string, string | undefined>,
): string | undefined {
  return provider === "gemini"
    ? env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY
    : env.OPENAI_API_KEY;
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
  const provider = options.provider ?? resolveQaProvider();
  const apiKey =
    options.apiKey ??
    process.env.AIKYA_QA_API_KEY ??
    providerKey(provider, process.env);
  const baseUrl = (
    options.baseUrl ??
    process.env.AIKYA_QA_BASE_URL ??
    (provider === "gemini" ? GEMINI_BASE_URL : OPENAI_BASE_URL)
  ).replace(/\/$/, "");
  const model =
    options.model ?? process.env.AIKYA_QA_MODEL ?? DEFAULT_QA_MODELS[provider];
  const fetchImpl = options.fetchImpl ?? fetch;

  if (!apiKey) {
    throw new QaModelError(
      provider === "gemini"
        ? "No Gemini API key. Set GEMINI_API_KEY (free tier: " +
          "https://aistudio.google.com/apikey) or AIKYA_QA_API_KEY, " +
          "or run `bun run qa` without --agent for deterministic checks."
        : "No model API key. Set OPENAI_API_KEY or AIKYA_QA_API_KEY, " +
          "or run `bun run qa` without --agent for deterministic checks.",
    );
  }

  return {
    model,
    provider,
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
