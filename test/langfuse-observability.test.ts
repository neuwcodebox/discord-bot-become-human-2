import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  createLangfuseAgentObserver,
  type LangfuseAgentClient,
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

  constructor(
    readonly id: string,
    readonly body: Parameters<LangfuseTrace["span"]>[0],
  ) {}

  event(body: LangfuseEventBody): unknown {
    this.events.push(body);
    return this;
  }

  end(body?: LangfuseSpanEndBody): unknown {
    if (body !== undefined) this.ended = body;
    return this;
  }
}

class FakeGeneration implements LangfuseGeneration {
  ended?: LangfuseGenerationEndBody;

  constructor(
    readonly id: string,
    readonly body: Parameters<LangfuseTrace["generation"]>[0],
  ) {}

  end(body?: LangfuseGenerationEndBody): unknown {
    if (body !== undefined) this.ended = body;
    return this;
  }
}

class FakeTrace implements LangfuseTrace {
  readonly spans: FakeSpan[] = [];
  readonly generations: FakeGeneration[] = [];
  updates: Array<Parameters<LangfuseTrace["update"]>[0]> = [];

  constructor(
    readonly id: string,
    readonly body: Parameters<LangfuseAgentClient["trace"]>[0],
  ) {}

  update(body?: Parameters<LangfuseTrace["update"]>[0]): unknown {
    if (body !== undefined) this.updates.push(body);
    return this;
  }

  span(body: Parameters<LangfuseTrace["span"]>[0]): LangfuseSpan {
    const span = new FakeSpan(`span-${this.spans.length + 1}`, body);
    this.spans.push(span);
    return span;
  }

  generation(body: Parameters<LangfuseTrace["generation"]>[0]): LangfuseGeneration {
    const generation = new FakeGeneration(`generation-${this.generations.length + 1}`, body);
    this.generations.push(generation);
    return generation;
  }
}

class FakeLangfuse implements LangfuseAgentClient {
  readonly traces: FakeTrace[] = [];
  readonly scores: LangfuseScoreBody[] = [];

  trace(body?: Parameters<LangfuseAgentClient["trace"]>[0]): LangfuseTrace {
    const trace = new FakeTrace(`trace-${this.traces.length + 1}`, body);
    this.traces.push(trace);
    return trace;
  }

  score(body: LangfuseScoreBody): unknown {
    this.scores.push(body);
    return this;
  }
}

describe("langfuse observability", () => {
  it("records assistant generations before repeated tool spans in pi-agent event order", async () => {
    const langfuse = new FakeLangfuse();
    const observer = createLangfuseAgentObserver({
      langfuse,
      traceLabel: "response",
      sessionId: "session-1",
      model: "gpt-test",
      provider: "openai",
      inputMessages: [
        { role: "system", content: "runtime policy" },
        { role: "user", content: "conversation transcript" },
        { role: "user", content: "please use tools" },
      ],
      startedAt: 1000,
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

    const trace = langfuse.traces[0];
    const expectedInput = [
      { role: "system", content: "runtime policy", contentLength: 14 },
      { role: "user", content: "conversation transcript", contentLength: 23 },
      { role: "user", content: "please use tools", contentLength: 16 },
    ];
    expect(trace?.body?.input).toEqual(expectedInput);
    expect(trace?.generations).toHaveLength(1);
    expect(trace?.spans).toHaveLength(2);
    expect(trace?.generations[0]?.body.input).toEqual(expectedInput);
    expect(trace?.generations[0]?.body.input).not.toBe("please use tools");
    expect(trace?.generations[0]?.body.metadata).toMatchObject({ eventOrder: 1 });
    expect(trace?.generations[0]?.ended?.output).toMatchObject({
      text: "checking",
      toolCalls: [
        { id: "call-1", name: "workspace_read", arguments: '{\n  "path": "a.txt"\n}' },
        { id: "call-2", name: "workspace_search", arguments: '{\n  "query": "needle"\n}' },
      ],
    });
    expect(trace?.generations[0]?.ended?.metadata).toMatchObject({
      toolCallCount: 2,
      toolCallNames: ["workspace_read", "workspace_search"],
    });
    expect(trace?.generations[0]?.ended?.output).not.toBe("");
    expect(trace?.spans[0]?.body.metadata).toMatchObject({ toolCallId: "call-1", eventOrder: 3 });
    expect(trace?.spans[1]?.body.metadata).toMatchObject({ toolCallId: "call-2", eventOrder: 5 });
    expect(trace?.spans[0]?.ended?.output).toBe("alpha");
    expect(trace?.spans[1]?.ended?.output).toBe("beta");
  });

  it("captures tool updates, tool errors, usage/cost details, and evaluation scores", async () => {
    const langfuse = new FakeLangfuse();
    const observer = createLangfuseAgentObserver({
      langfuse,
      sessionId: "session-2",
      model: "gpt-test",
      provider: "openai",
      inputMessages: [{ role: "user", content: "search with token" }],
      startedAt: 1000,
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

    const trace = langfuse.traces[0];
    const generation = trace?.generations[0];
    const span = trace?.spans[0];
    expect(generation?.ended).toMatchObject({
      output: longOutput,
      usage: { input: 10, output: 4, total: 14 },
      costDetails: { input: 0.01, output: 0.02, total: 0.03 },
    });
    expect(String(generation?.ended?.output)).not.toContain("(truncated)");
    expect(span?.body.input).toContain("[REDACTED]");
    expect(span?.events).toHaveLength(1);
    expect(span?.ended).toMatchObject({
      level: "ERROR",
      statusMessage: "network unavailable",
      output: "network unavailable",
    });
    expect(langfuse.scores).toEqual(
      expect.arrayContaining([
        { name: "tool_is_error", value: 1, traceId: "trace-1", observationId: "span-1" },
        { name: "tool_call_count", value: 1, traceId: "trace-1" },
        { name: "turn_count", value: 1, traceId: "trace-1" },
        { name: "total_tool_errors", value: 1, traceId: "trace-1" },
        { name: "tool_success_rate", value: 0, traceId: "trace-1" },
        { name: "session_had_errors", value: 1, traceId: "trace-1" },
      ]),
    );
    expect(langfuse.scores.some((score) => score.name.includes("token"))).toBe(false);
    expect(trace?.updates[0]).toMatchObject({
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
});

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
