import { describe, expect, test } from "bun:test";
import { createOpenAiModel, QaModelError } from "./model.ts";
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
