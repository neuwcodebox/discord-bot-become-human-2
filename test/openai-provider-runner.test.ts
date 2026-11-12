import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AgentProviderError, sanitizeProviderError } from "../src/agent/provider-error.js";
import { OpenAICompatibleAgentRunner } from "../src/agent/runner.js";
import { defaultConfig } from "../src/config.js";
import { createToolRegistry } from "../src/tools/tool-registry.js";
import type { AgentContextMessage } from "../src/types.js";

const failure =
  "Function tools with reasoning_effort are not supported for gpt-6.1-sol in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
function setup(model = "gpt-6.1-sol", baseURL = "https://api.openai.com/v1") {
  vi.stubEnv("TEST_OPENAI_KEY", "mock-key");
  const config = {
    ...defaultConfig,
    llm: {
      provider: "openai-compatible" as const,
      model,
      baseURL,
      apiKeyEnv: "TEST_OPENAI_KEY",
      reasoning: "high" as const,
      contextWindow: 128000,
    },
  };
  return {
    runner: new OpenAICompatibleAgentRunner(config),
    tools: createToolRegistry(config, { guildId: "test", workspaceRoot: "/tmp" }),
  };
}
function completed() {
  return new Response(
    `data: ${JSON.stringify({ type: "response.completed", response: { id: "r1", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } } })}\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
}
describe("OpenAI transport and failures", () => {
  it("round-trips a Responses image function call and its result without replay", async () => {
    const { runner, tools } = setup();
    const image = tools.find((tool) => tool.name === "generate_image");
    if (!image) throw new Error("Missing image tool");
    const execute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: '{"path":"generated/images/test.png"}' }],
      details: {},
    }));
    const call = {
      type: "function_call",
      id: "fc_1",
      call_id: "call_1",
      name: "generate_image",
      arguments: '{"prompt":"bird"}',
      status: "completed",
    };
    const message = {
      type: "message",
      id: "msg_1",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Done", annotations: [] }],
    };
    const response = (item: unknown) =>
      new Response(
        [
          { type: "response.output_item.done", output_index: 0, item },
          {
            type: "response.completed",
            response: {
              id: "r1",
              status: "completed",
              output: [item],
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            },
          },
        ]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(call))
      .mockResolvedValueOnce(response(message));
    vi.stubGlobal("fetch", fetcher);
    const result = await runner.run({
      sessionId: "roundtrip",
      messages: [...fixedMessages, taskA],
      tools: [{ ...image, execute }],
    });
    expect(result.text).toBe("Done");
    expect(execute).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledTimes(2);
    const continuation = String(fetcher.mock.calls[1]?.[1]?.body);
    expect(continuation).toContain("function_call_output");
    expect(continuation).toContain('"call_id":"call_1"');
    expect(continuation).toContain('"id":"fc_1"');
    expect(continuation).toContain("generated/images/test.png");
    expect(continuation).toContain('"effort":"high"');
    const initialPayload = readWire(fetcher.mock.calls[0]?.[1]?.body);
    const continuedPayload = readWire(fetcher.mock.calls[1]?.[1]?.body);
    expect(continuedPayload.input.slice(0, 4)).toEqual(initialPayload.input);
    expect(continuedPayload.input[3]).toEqual({
      role: "developer",
      content: taskA.content,
    });
    expect(initialPayload.input[0]).toEqual({
      role: "developer",
      content: [
        { type: "input_text", text: "Fixed instructions", prompt_cache_breakpoint: { mode: "explicit" } },
      ],
    });
    expect(continuedPayload.prompt_cache_options).toEqual({ mode: "implicit" });
  });
  it("sends official GPT-6 reasoning and image tools to Responses, not Chat Completions", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(completed());
    vi.stubGlobal("fetch", fetcher);
    const { runner, tools } = setup();
    await runner.run({ sessionId: "probe", messages: [{ role: "user", content: "Draw a bird" }], tools });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(String(fetcher.mock.calls[0]?.[0])).toBe("https://api.openai.com/v1/responses");
    const body = String(fetcher.mock.calls[0]?.[1]?.body);
    expect(body).toContain('"effort":"high"');
    expect(body).toContain('"name":"generate_image"');
    expect(body).toContain('"name":"edit_image"');
    expect(body).toContain('"store":false');
    expect(body).not.toContain('"reasoning_effort"');
  });
  it.each([
    ["gpt-5.5", "https://api.openai.com/v1"],
    ["gpt-6.1-sol", "https://example.test/v1"],
  ])("preserves Chat Completions for %s at %s", async (model, baseURL) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ error: { message: failure, type: "invalid_request_error" } }, { status: 400 }),
      );
    vi.stubGlobal("fetch", fetcher);
    const { runner, tools } = setup(model, baseURL);
    await expect(
      runner.run({ sessionId: "probe", messages: [{ role: "user", content: "Draw" }], tools }),
    ).rejects.toBeInstanceOf(AgentProviderError);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(`${baseURL}/chat/completions`);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("propagates HTTP 400 as error, never a successful blank reply", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { error: { message: failure, type: "invalid_request_error", param: "reasoning_effort" } },
          { status: 400 },
        ),
      );
    vi.stubGlobal("fetch", fetcher);
    const { runner, tools } = setup();
    await expect(
      runner.run({ sessionId: "probe", messages: [{ role: "user", content: "Draw" }], tools }),
    ).rejects.toThrow("Function tools with reasoning_effort");
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("bounds and redacts operational diagnostics", () => {
    const safe = sanitizeProviderError(
      "400 api_key=secret Bearer credential sk-private https://test.invalid/?token=secret data:image/png;base64,ABC",
    );
    expect(safe).not.toMatch(/secret|credential|sk-private|ABC|test.invalid/);
    expect(
      sanitizeProviderError(
        JSON.stringify({
          nested: {
            token: "private-token-value",
            refresh: "private-refresh-value",
            client_secret: "private-secret-value",
          },
        }),
      ),
    ).not.toContain("private-");
    expect(
      sanitizeProviderError(JSON.stringify(JSON.stringify({ token: "private-nested-token" }))),
    ).not.toContain("private-");
    expect(sanitizeProviderError("x".repeat(2000))).toHaveLength(1000);
  });
});

const wirePayloadSchema = z
  .object({
    input: z.array(z.object({ role: z.string().optional() }).passthrough()),
    prompt_cache_options: z.unknown().optional(),
    prompt_cache_key: z.string().optional(),
    prompt_cache_retention: z.unknown().optional(),
  })
  .passthrough();
const fixedMessages: AgentContextMessage[] = [
  { role: "system", content: "Fixed instructions", cacheBreakpoint: true },
  { role: "user", content: "Memory and profiles" },
  { role: "user", content: '<transcript><msg id="A" author="Alice">Hello</msg></transcript>' },
];
const taskA: AgentContextMessage = { role: "developer", content: '<task>{"targetMessageIds":["A"]}</task>' };
const taskB: AgentContextMessage = { role: "developer", content: '<task>{"targetMessageIds":["B"]}</task>' };
function readWire(body: unknown) {
  return wirePayloadSchema.parse(JSON.parse(String(body)));
}

describe("prompt cache wire layout", () => {
  it("keeps the reusable prefix identical when appending messages and changing targets", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => completed());
    vi.stubGlobal("fetch", fetcher);
    const { runner } = setup();
    await runner.run({ sessionId: "append", messages: [...fixedMessages, taskA], allowEmptyText: true });
    await runner.run({
      sessionId: "append",
      messages: [
        ...fixedMessages,
        { role: "user", content: '<transcript><msg id="B" author="Bob">Hi</msg></transcript>' },
        taskB,
      ],
      allowEmptyText: true,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const first = readWire(fetcher.mock.calls[0]?.[1]?.body);
    const second = readWire(fetcher.mock.calls[1]?.[1]?.body);
    expect(second.input.slice(0, 3)).toEqual(first.input.slice(0, 3));
    expect(first.input.map((item) => item.role)).toEqual(["developer", "user", "user", "developer"]);
    expect(second.input.map((item) => item.role)).toEqual(["developer", "user", "user", "user", "developer"]);
    expect(first.input.at(-1)).toEqual({
      role: "developer",
      content: taskA.content,
    });
    expect(second.input.at(-1)).toEqual({
      role: "developer",
      content: taskB.content,
    });
    expect(first.prompt_cache_key).toBe("append");
    expect(second.prompt_cache_key).toBe(first.prompt_cache_key);
    expect(second.prompt_cache_options).toEqual({ mode: "implicit" });
    expect(second.prompt_cache_retention).toBeUndefined();
    expect(first.input[0]).toEqual({
      role: "developer",
      content: [
        { type: "input_text", text: "Fixed instructions", prompt_cache_breakpoint: { mode: "explicit" } },
      ],
    });
  });
  it.each([
    ["gpt-5.5", "https://api.openai.com/v1"],
    ["gpt-6.1-sol", "https://example.test/v1"],
  ])("preserves task instructions without cache extensions for %s at %s", async (model, baseURL) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json({ error: { message: failure } }, { status: 400 }));
    vi.stubGlobal("fetch", fetcher);
    const { runner } = setup(model, baseURL);
    await expect(
      runner.run({ sessionId: "legacy", messages: [...fixedMessages, taskA] }),
    ).rejects.toBeInstanceOf(AgentProviderError);
    const body = String(fetcher.mock.calls[0]?.[1]?.body);
    const payload = z
      .object({ messages: z.array(z.object({ role: z.string(), content: z.unknown() })) })
      .parse(JSON.parse(body));
    expect(payload.messages[0]).toEqual({
      role: "system",
      content: `Fixed instructions\n\n${taskA.content}`,
    });
    expect(payload.messages.slice(1).map((item) => item.role)).toEqual(["user", "user"]);
    expect(body).not.toContain("prompt_cache_options");
    expect(body).not.toContain("prompt_cache_breakpoint");
    expect(body).not.toContain("cacheBreakpoint");
    expect(body).not.toContain("budgetGroup");
  });
});
