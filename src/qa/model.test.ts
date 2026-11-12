import { describe, expect, test } from "bun:test";
import {
  createOpenAiModel,
  DEFAULT_QA_MODELS,
  GEMINI_BASE_URL,
  OPENAI_BASE_URL,
  QaModelError,
  resolveQaProvider,
} from "./model.ts";
import type { ToolDefinition } from "./model.ts";

const tools: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "read",
      parameters: { type: "object", properties: { path: { type: "string" } } },
    },
  },
];

interface Captured {
  url: string;
  body: Record<string, unknown>;
  authorization: string | null;
}

function fakeFetch(
  respond: () => Response,
): { fetchImpl: typeof fetch; captured: Captured[] } {
  const captured: Captured[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    captured.push({
      url: String(input),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      authorization: headers.get("authorization"),
    });
    return respond();
  }) as typeof fetch;
  return { fetchImpl, captured };
}

describe("createOpenAiModel", () => {
  test("posts an OpenAI-compatible request and parses tool calls", async () => {
    const { fetchImpl, captured } = fakeFetch(
      () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: "call_1",
                      type: "function",
                      function: {
                        name: "read_file",
                        arguments: '{"path":"src/index.ts"}',
                      },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 11, completion_tokens: 7 },
          }),
          { status: 200 },
        ),
    );

    const client = createOpenAiModel({
      apiKey: "test-key",
      baseUrl: "https://example.test/v1/",
      model: "test-model",
      fetchImpl,
    });
    const reply = await client.complete({
      messages: [{ role: "user", content: "hello" }],
      tools,
    });

    expect(reply.toolCalls).toHaveLength(1);
    expect(reply.toolCalls[0]?.function.name).toBe("read_file");
    expect(reply.toolCalls[0]?.function.arguments).toBe('{"path":"src/index.ts"}');
    expect(reply.promptTokens).toBe(11);
    expect(reply.completionTokens).toBe(7);

    expect(captured[0]?.url).toBe("https://example.test/v1/chat/completions");
    expect(captured[0]?.authorization).toBe("Bearer test-key");
    expect(captured[0]?.body.model).toBe("test-model");
    expect(captured[0]?.body.tool_choice).toBe("auto");
  });

  test("returns plain content when the model does not call a tool", async () => {
    const { fetchImpl } = fakeFetch(
      () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "nothing to fix" } }],
          }),
          { status: 200 },
        ),
    );

    const client = createOpenAiModel({ apiKey: "k", fetchImpl });
    const reply = await client.complete({
      messages: [{ role: "user", content: "hello" }],
      tools,
    });

    expect(reply.content).toBe("nothing to fix");
    expect(reply.toolCalls).toEqual([]);
    expect(reply.promptTokens).toBeNull();
  });

  test("surfaces an HTTP error with the response body", async () => {
    const { fetchImpl } = fakeFetch(
      () => new Response("rate limited", { status: 429 }),
    );
    const client = createOpenAiModel({ apiKey: "k", fetchImpl });

    await expect(
      client.complete({ messages: [{ role: "user", content: "hi" }], tools }),
    ).rejects.toThrow(QaModelError);
  });

  test("rejects non-JSON output", async () => {
    const { fetchImpl } = fakeFetch(() => new Response("<html>", { status: 200 }));
    const client = createOpenAiModel({ apiKey: "k", fetchImpl });

    await expect(
      client.complete({ messages: [{ role: "user", content: "hi" }], tools }),
    ).rejects.toThrow("non-JSON");
  });
});

function withEnv<T>(values: Record<string, string | undefined>, run: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("resolveQaProvider", () => {
  test("defaults to OpenAI with no hints", () => {
    expect(resolveQaProvider({})).toBe("openai");
  });

  test("honours an explicit provider", () => {
    expect(resolveQaProvider({ AIKYA_QA_PROVIDER: "gemini" })).toBe("gemini");
    expect(resolveQaProvider({ AIKYA_QA_PROVIDER: "OPENAI" })).toBe("openai");
  });

  test("detects Gemini from the base URL or key", () => {
    expect(
      resolveQaProvider({ AIKYA_QA_BASE_URL: "https://generativelanguage.googleapis.com/v1beta/openai" }),
    ).toBe("gemini");
    expect(resolveQaProvider({ GEMINI_API_KEY: "g" })).toBe("gemini");
    expect(resolveQaProvider({ GOOGLE_API_KEY: "g" })).toBe("gemini");
  });

  test("a generic AIKYA_QA_API_KEY does not imply Gemini", () => {
    expect(resolveQaProvider({ AIKYA_QA_API_KEY: "k" })).toBe("openai");
  });
});

describe("Gemini compatibility", () => {
  test("uses the Gemini base URL and a free-tier default model", async () => {
    const { fetchImpl, captured } = fakeFetch(
      () =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
          { status: 200 },
        ),
    );

    await withEnv(
      {
        AIKYA_QA_MODEL: undefined,
        AIKYA_QA_BASE_URL: undefined,
        AIKYA_QA_API_KEY: undefined,
      },
      async () => {
        const client = createOpenAiModel({
          provider: "gemini",
          apiKey: "gemini-key",
          fetchImpl,
        });
        expect(client.provider).toBe("gemini");
        expect(client.model).toBe(DEFAULT_QA_MODELS.gemini);
        await client.complete({
          messages: [{ role: "user", content: "hi" }],
          tools,
        });

        expect(captured[0]?.url).toBe(`${GEMINI_BASE_URL}/chat/completions`);
        expect(captured[0]?.body.model).toBe("gemini-3.8-flash");
        expect(captured[0]?.body.tool_choice).toBe("auto");
      },
    );
  });

  test("reads GEMINI_API_KEY and reports a Gemini-specific missing key", async () => {
    await withEnv(
      {
        AIKYA_QA_API_KEY: undefined,
        GEMINI_API_KEY: undefined,
        GOOGLE_API_KEY: undefined,
        AIKYA_QA_MODEL: undefined,
      },
      () => {
        expect(() => createOpenAiModel({ provider: "gemini" })).toThrow(
          /Gemini API key/,
        );
      },
    );

    await withEnv(
      {
        AIKYA_QA_API_KEY: undefined,
        GEMINI_API_KEY: "gemini-key",
        GOOGLE_API_KEY: undefined,
        AIKYA_QA_MODEL: undefined,
      },
      () => {
        const client = createOpenAiModel({ provider: "gemini" });
        expect(client.model).toBe(DEFAULT_QA_MODELS.gemini);
      },
    );
  });

  test("keeps the OpenAI base URL when the provider is OpenAI", async () => {
    const { fetchImpl, captured } = fakeFetch(
      () =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
          { status: 200 },
        ),
    );

    await withEnv(
      { AIKYA_QA_BASE_URL: undefined, AIKYA_QA_MODEL: undefined },
      async () => {
        const client = createOpenAiModel({
          provider: "openai",
          apiKey: "k",
          fetchImpl,
        });
        await client.complete({
          messages: [{ role: "user", content: "hi" }],
          tools,
        });
        expect(captured[0]?.url).toBe(`${OPENAI_BASE_URL}/chat/completions`);
        expect(captured[0]?.body.model).toBe(DEFAULT_QA_MODELS.openai);
      },
    );
  });
});
