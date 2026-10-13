import { LangfuseClient } from "@langfuse/client";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { LangfuseOtelSpanAttributes, setLangfuseTracerProvider } from "@langfuse/tracing";
import { context, trace } from "@opentelemetry/api";
import { InMemorySpanExporter, NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createLangfuseAgentClient } from "../src/observability/langfuse-client.js";

describe("Langfuse v5 SDK integration", () => {
  const exporter = new InMemorySpanExporter();
  const processor = new LangfuseSpanProcessor({
    publicKey: "pk-test",
    secretKey: "sk-test",
    exporter,
    exportMode: "immediate",
  });
  const provider = new NodeTracerProvider({ spanProcessors: [processor] });
  provider.register();
  setLangfuseTracerProvider(provider);
  const client = new LangfuseClient({ publicKey: "pk-test", secretKey: "sk-test" });

  beforeEach(() => {
    exporter.reset();
  });

  afterAll(async () => {
    await Promise.all([provider.shutdown(), client.shutdown()]);
    setLangfuseTracerProvider(null);
    context.disable();
    trace.disable();
  });

  it("exports parented observations with session, usage, costs and numeric scores", async () => {
    const score = vi.spyOn(client.score, "create").mockImplementation(() => {});
    const agentClient = createLangfuseAgentClient(client);
    const run = agentClient.startRun({
      name: "response",
      timestamp: new Date(1000),
      sessionId: "discord:guild:channel",
      input: [{ role: "user", content: "hello" }],
    });
    // Simulate pi events arriving after leaving the root creation context.
    await Promise.resolve();
    const generation = run.startGeneration({
      name: "llm-response",
      model: "test-model",
      startTime: new Date(2000),
    });
    generation.end({
      output: "done",
      usageDetails: { input: 10, output: 4, total: 14 },
      costDetails: { input: 0.01, output: 0.02, total: 0.03 },
    });
    const tool = run.startTool({ name: "tool:workspace_read", startTime: new Date(3000) });
    tool.event({ name: "tool_update", output: "partial" });
    tool.end({ output: "failure", level: "ERROR", statusMessage: "read failed" });
    agentClient.createScore({ name: "tool_is_error", value: 1, traceId: run.id, observationId: tool.id });
    run.update({ output: "done", metadata: { completed: true } });
    run.end();
    await provider.forceFlush();

    const spans = exporter.getFinishedSpans();
    const root = spanNamed(spans, "response");
    const llm = spanNamed(spans, "llm-response");
    const toolSpan = spanNamed(spans, "tool:workspace_read");
    const update = spanNamed(spans, "tool_update");
    expect(spans).toHaveLength(4);
    expect(root.attributes[LangfuseOtelSpanAttributes.OBSERVATION_TYPE]).toBe("agent");
    expect(toolSpan.attributes[LangfuseOtelSpanAttributes.OBSERVATION_TYPE]).toBe("tool");
    expect(llm.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
    expect(toolSpan.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
    expect(tool.id).toBe(toolSpan.spanContext().spanId);
    expect(update.parentSpanContext?.spanId).toBe(toolSpan.spanContext().spanId);
    expect(llm.startTime).toEqual([2, 0]);
    expect(toolSpan.startTime).toEqual([3, 0]);
    for (const span of spans) {
      expect(span.spanContext().traceId).toBe(run.id);
      expect(span.attributes[LangfuseOtelSpanAttributes.TRACE_SESSION_ID]).toBe("discord:guild:channel");
      expect(span.attributes[LangfuseOtelSpanAttributes.TRACE_NAME]).toBe("response");
    }
    expect(root.attributes[LangfuseOtelSpanAttributes.OBSERVATION_OUTPUT]).toBe("done");
    expect(parseJson(llm.attributes[LangfuseOtelSpanAttributes.OBSERVATION_USAGE_DETAILS])).toEqual({
      input: 10,
      output: 4,
      total: 14,
    });
    expect(parseJson(llm.attributes[LangfuseOtelSpanAttributes.OBSERVATION_COST_DETAILS])).toEqual({
      input: 0.01,
      output: 0.02,
      total: 0.03,
    });
    expect(score).toHaveBeenCalledWith({
      name: "tool_is_error",
      value: 1,
      traceId: run.id,
      observationId: tool.id,
      dataType: "NUMERIC",
    });
  });

  it("keeps overlapping runs in separate traces and sessions", async () => {
    const agentClient = createLangfuseAgentClient(client);
    const first = agentClient.startRun({ name: "first", sessionId: "session-1" });
    const second = agentClient.startRun({ name: "second", sessionId: "session-2" });
    const secondGeneration = second.startGeneration({ name: "second-generation" });
    await Promise.resolve();
    const firstGeneration = first.startGeneration({ name: "first-generation" });
    firstGeneration.end();
    secondGeneration.end();
    second.end();
    first.end();
    await provider.forceFlush();

    expect(first.id).not.toBe(second.id);
    const spans = exporter.getFinishedSpans();
    expect(spans.map((span) => span.name).sort()).toEqual([
      "first",
      "first-generation",
      "second",
      "second-generation",
    ]);
    for (const span of spans) {
      const isFirst = span.name.startsWith("first");
      expect(span.spanContext().traceId).toBe(isFirst ? first.id : second.id);
      expect(span.attributes[LangfuseOtelSpanAttributes.TRACE_SESSION_ID]).toBe(
        isFirst ? "session-1" : "session-2",
      );
    }
  });
});

function spanNamed(spans: ReturnType<InMemorySpanExporter["getFinishedSpans"]>, name: string) {
  const span = spans.find((entry) => entry.name === name);
  if (!span) throw new Error(`Expected exported span ${name}`);
  return span;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") throw new Error("Expected a serialized JSON attribute");
  return JSON.parse(value);
}
