import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createLangfuseAgentObserver,
  type LangfuseAgentClient,
  type LangfuseAgentObserverOptions,
  type LangfuseEventBody,
  type LangfuseGeneration,
  type LangfuseGenerationEndBody,
  type LangfuseScoreBody,
  type LangfuseSpan,
  type LangfuseSpanEndBody,
  type LangfuseTrace,
} from "../src/observability/langfuse.js";

type AssistantContent = Extract<AgentMessage, { role: "assistant" }>["content"];
type ToolResultContent = Extract<AgentMessage, { role: "toolResult" }>["content"];

class FakeSpan implements LangfuseSpan {
  readonly events: LangfuseEventBody[] = [];
  ended?: LangfuseSpanEndBody;
  endCount = 0;

  constructor(
    readonly id: string,
    readonly body: Parameters<LangfuseTrace["startTool"]>[0],
  ) {}

  event(body: LangfuseEventBody): unknown {
    this.events.push(body);
    return this;
  }

  end(body?: LangfuseSpanEndBody): unknown {
    this.endCount += 1;
    if (body !== undefined) this.ended = body;
    return this;
  }
}

class FakeGeneration implements LangfuseGeneration {
  ended?: LangfuseGenerationEndBody;
  endCount = 0;

  constructor(
    readonly id: string,
    readonly body: Parameters<LangfuseTrace["startGeneration"]>[0],
  ) {}

  end(body?: LangfuseGenerationEndBody): unknown {
    this.endCount += 1;
    if (body !== undefined) this.ended = body;
    return this;
  }
}

class FakeTrace implements LangfuseTrace {
  readonly spans: FakeSpan[] = [];
  readonly generations: FakeGeneration[] = [];
  readonly updates: Array<Parameters<LangfuseTrace["update"]>[0]> = [];
  endCount = 0;

  constructor(
    readonly id: string,
    readonly body: Parameters<LangfuseAgentClient["startRun"]>[0],
  ) {}

  update(body?: Parameters<LangfuseTrace["update"]>[0]): unknown {
    if (body !== undefined) this.updates.push(body);
    return this;
  }

  end(): void {
    this.endCount += 1;
  }

  startTool(body: Parameters<LangfuseTrace["startTool"]>[0]): LangfuseSpan {
    const span = new FakeSpan(`span-${this.spans.length + 1}`, body);
    this.spans.push(span);
    return span;
  }

  startGeneration(body: Parameters<LangfuseTrace["startGeneration"]>[0]): LangfuseGeneration {
    const generation = new FakeGeneration(`generation-${this.generations.length + 1}`, body);
    this.generations.push(generation);
    return generation;
  }
}

class FakeLangfuse implements LangfuseAgentClient {
  readonly traces: FakeTrace[] = [];
  readonly scores: LangfuseScoreBody[] = [];

  startRun(body: Parameters<LangfuseAgentClient["startRun"]>[0]): LangfuseTrace {
    const trace = new FakeTrace(`trace-${this.traces.length + 1}`, body);
    this.traces.push(trace);
    return trace;
  }

  createScore(body: LangfuseScoreBody): unknown {
    this.scores.push(body);
    return this;
  }
}

describe("langfuse observability", () => {
  it("records assistant generations before repeated tool spans in pi-agent event order", async () => {
    const { observer, trace } = createObserver({
      traceLabel: "response",
      sessionId: "session-1",
      inputMessages: [
        { role: "system", content: "runtime policy" },
        { role: "user", content: "conversation transcript" },
        { role: "user", content: "please use tools" },
      ],
    });

    await observer.handleEvent({ type: "message_start", message: assistantMessage([]) });
    await observer.handleEvent({
      type: "message_end",
      message: assistantMessage([
        { type: "text", text: "checking" },
        { type: "toolCall", id: "call-1", name: "workspace_read", arguments: { path: "a.txt" } },
        { type: "toolCall", id: "call-2", name: "workspace_search", arguments: { query: "needle" } },
      ]),
    });
    await observer.handleEvent(toolStart("call-1", "workspace_read", { path: "a.txt" }));
    await observer.handleEvent(toolEnd("call-1", "workspace_read", toolResult("alpha"), false));
    await observer.handleEvent(toolStart("call-2", "workspace_search", { query: "needle" }));
    await observer.handleEvent(toolEnd("call-2", "workspace_search", toolResult("beta"), false));
    await observer.handleEvent({
      type: "turn_end",
      message: assistantMessage([]),
      toolResults: [
        toolResultMessage("call-1", "workspace_read"),
        toolResultMessage("call-2", "workspace_search"),
      ],
    });

    const expectedInput = [
      { role: "system", content: "runtime policy", contentLength: 14 },
      { role: "user", content: "conversation transcript", contentLength: 23 },
      { role: "user", content: "please use tools", contentLength: 16 },
    ];
    expect(trace.body.input).toEqual(expectedInput);
    expect(trace.generations).toHaveLength(1);
    expect(trace.spans).toHaveLength(2);
    const generation = required(trace.generations[0], "assistant generation");
    const firstTool = required(trace.spans[0], "first tool span");
    const secondTool = required(trace.spans[1], "second tool span");
    const generationEnd = required(generation.ended, "completed assistant generation");
    expect(generation.body.input).toEqual(expectedInput);
    expect(observationOrder(generation)).toBeLessThan(observationOrder(firstTool));
    expect(observationOrder(firstTool)).toBeLessThan(observationOrder(secondTool));
    expect(parseToolCallOutput(generationEnd.output)).toEqual({
      text: "checking",
      toolCalls: [
        { id: "call-1", name: "workspace_read", arguments: { path: "a.txt" } },
        { id: "call-2", name: "workspace_search", arguments: { query: "needle" } },
      ],
    });
    expect(generationEnd.metadata).toMatchObject({
      toolCallCount: 2,
      toolCallNames: ["workspace_read", "workspace_search"],
    });
    expect(firstTool.body.metadata).toMatchObject({ toolCallId: "call-1" });
    expect(secondTool.body.metadata).toMatchObject({ toolCallId: "call-2" });
    expect(required(firstTool.ended, "completed first tool span").output).toBe("alpha");
    expect(required(secondTool.ended, "completed second tool span").output).toBe("beta");
  });

  it("captures tool updates, tool errors, usage/cost details, and evaluation scores", async () => {
    const { langfuse, observer, trace } = createObserver({
      sessionId: "session-2",
      inputMessages: [{ role: "user", content: "search with token" }],
    });
    const longOutput = `done ${"x".repeat(2500)}`;
    const finalMessage = assistantMessage([{ type: "text", text: longOutput }]);

    await observer.handleEvent({ type: "message_start", message: assistantMessage([]) });
    await observer.handleEvent({ type: "message_end", message: finalMessage });
    await observer.handleEvent(
      toolStart("call-error", "search_internet", { query: "x", apiToken: "secret" }),
    );
    await observer.handleEvent({
      type: "tool_execution_update",
      toolCallId: "call-error",
      toolName: "search_internet",
      args: { query: "x" },
      partialResult: toolResult("partial"),
    });
    await observer.handleEvent(
      toolEnd("call-error", "search_internet", toolResult("network unavailable"), true),
    );
    await observer.handleEvent({
      type: "turn_end",
      message: finalMessage,
      toolResults: [toolResultMessage("call-error", "search_internet", true)],
    });
    await observer.handleEvent({
      type: "agent_end",
      messages: [
        assistantMessage([
          {
            type: "toolCall",
            id: "call-error",
            name: "search_internet",
            arguments: { query: "x" },
          },
        ]),
        toolResultMessage("call-error", "search_internet", true),
        finalMessage,
      ],
    });

    const generation = required(trace.generations[0], "assistant generation");
    const span = required(trace.spans[0], "tool span");
    expect(generation.ended).toMatchObject({
      output: longOutput,
      usageDetails: { input: 10, output: 4, total: 14 },
      costDetails: { input: 0.01, output: 0.02, total: 0.03 },
    });
    expect(parseJson(span.body.input)).toEqual({ query: "x", apiToken: "[REDACTED]" });
    expect(span.events).toEqual([expect.objectContaining({ name: "tool_update", output: "partial" })]);
    expect(span.ended).toMatchObject({
      level: "ERROR",
      statusMessage: "network unavailable",
      output: "network unavailable",
    });
    expect(langfuse.scores).toEqual(
      expect.arrayContaining([
        { name: "tool_is_error", value: 1, traceId: trace.id, observationId: span.id },
        { name: "tool_call_count", value: 1, traceId: trace.id },
        { name: "turn_count", value: 1, traceId: trace.id },
        { name: "total_tool_errors", value: 1, traceId: trace.id },
        { name: "tool_success_rate", value: 0, traceId: trace.id },
        { name: "session_had_errors", value: 1, traceId: trace.id },
      ]),
    );
    expect(langfuse.scores.some((score) => score.name.includes("token"))).toBe(false);
    expect(trace.updates[0]).toMatchObject({
      output: longOutput,
      metadata: {
        completed: true,
        toolCallCount: 1,
        toolErrorCount: 1,
        tool_call_count: 1,
        session_had_errors: 1,
      },
    });
  });

  it("records the current ReAct context as generation input when available", async () => {
    const { observer, trace } = createObserver({
      sessionId: "session-react",
      systemPrompt: "runtime policy",
      inputMessages: [
        { role: "system", content: "runtime policy" },
        { role: "user", content: "initial task" },
      ],
      getGenerationMessages: () => [
        {
          role: "user",
          content: [{ type: "text", text: "initial task" }],
          timestamp: 1000,
        },
        assistantMessage([
          { type: "toolCall", id: "call-1", name: "workspace_read", arguments: { path: "a.txt" } },
        ]),
        toolResultMessage("call-1", "workspace_read"),
      ],
    });

    await observer.handleEvent({ type: "message_start", message: assistantMessage([]) });

    const generation = required(trace.generations[0], "ReAct generation");
    const inputMessages = z.array(z.record(z.string(), z.unknown())).parse(generation.body.input);
    const generationInput = inputMessages.map((message) =>
      message.role === "assistant" ? { ...message, content: parseToolCallOutput(message.content) } : message,
    );
    expect(generationInput).toEqual([
      { role: "system", content: "runtime policy", contentLength: 14 },
      expect.objectContaining({
        role: "user",
        content: [{ type: "text", text: "initial task", contentLength: 12 }],
      }),
      expect.objectContaining({
        role: "assistant",
        content: {
          toolCalls: [{ id: "call-1", name: "workspace_read", arguments: { path: "a.txt" } }],
        },
      }),
      expect.objectContaining({
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "workspace_read",
        content: [{ type: "text", text: "result", contentLength: 6 }],
      }),
    ]);
  });

  it("ends unfinished observations and the root exactly once", async () => {
    const { observer, trace } = createObserver({
      sessionId: "interrupted-run",
      inputMessages: [],
    });
    await observer.handleEvent({ type: "message_start", message: assistantMessage([]) });
    await observer.handleEvent(toolStart("call-1", "workspace_read", {}));
    await observer.handleEvent({ type: "agent_end", messages: [] });
    observer.finish("", []);

    const generation = required(trace.generations[0], "unfinished generation");
    const span = required(trace.spans[0], "unfinished tool span");
    expect(generation.ended?.metadata).toMatchObject({ incomplete: true });
    expect(span.ended?.metadata).toMatchObject({ incomplete: true });
    expect(generation.endCount).toBe(1);
    expect(span.endCount).toBe(1);
    expect(trace.endCount).toBe(1);
  });
});

function createObserver(options: Partial<Omit<LangfuseAgentObserverOptions, "langfuse">> = {}) {
  const langfuse = new FakeLangfuse();
  const observer = createLangfuseAgentObserver({
    sessionId: "test-session",
    model: "gpt-test",
    provider: "openai",
    inputMessages: [],
    startedAt: 1000,
    ...options,
    langfuse,
  });
  return { langfuse, observer, trace: required(langfuse.traces[0], "agent trace") };
}

function required<T>(value: T | undefined, description: string): T {
  if (value === undefined) throw new Error(`Expected ${description}`);
  return value;
}

function observationOrder(observation: FakeSpan | FakeGeneration): number {
  const order = observation.body.metadata?.eventOrder;
  if (typeof order !== "number") throw new Error("Expected numeric observation event order");
  return order;
}

const toolCallOutputSchema = z.object({
  text: z.string().optional(),
  toolCalls: z.array(z.object({ id: z.string(), name: z.string(), arguments: z.string() })),
});

function parseToolCallOutput(value: unknown) {
  const output = toolCallOutputSchema.parse(value);
  return {
    ...output,
    toolCalls: output.toolCalls.map((toolCall) => ({
      ...toolCall,
      arguments: parseJson(toolCall.arguments),
    })),
  };
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") throw new Error("Expected serialized JSON");
  return JSON.parse(value);
}

function assistantMessage(content: AssistantContent): Extract<AgentMessage, { role: "assistant" }> {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "openai",
    model: "gpt-test",
    usage: {
      input: 10,
      output: 4,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 14,
      cost: {
        input: 0.01,
        output: 0.02,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0.03,
      },
    },
    stopReason: "stop",
    timestamp: 1000,
  };
}

function toolStart(toolCallId: string, toolName: string, args: Record<string, unknown>): AgentEvent {
  return {
    type: "tool_execution_start",
    toolCallId,
    toolName,
    args,
  };
}

function toolEnd(toolCallId: string, toolName: string, result: unknown, isError: boolean): AgentEvent {
  return {
    type: "tool_execution_end",
    toolCallId,
    toolName,
    result,
    isError,
  };
}

function toolResult(text: string): { content: ToolResultContent; details: Record<string, unknown> } {
  return {
    content: [{ type: "text", text }],
    details: {},
  };
}

function toolResultMessage(
  toolCallId: string,
  toolName: string,
  isError = false,
): Extract<AgentMessage, { role: "toolResult" }> {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text: "result" }],
    details: {},
    isError,
    timestamp: 1000,
  };
}
