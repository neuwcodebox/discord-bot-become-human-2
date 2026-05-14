import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  instrumentToolsForLangfuse,
  type LangfuseToolObservation,
  type LangfuseToolObservationEnd,
  type LangfuseToolObservationEvent,
  type LangfuseToolObservationParent,
} from "../src/observability/langfuse.js";

class FakeSpan implements LangfuseToolObservation {
  readonly events: LangfuseToolObservationEvent[] = [];
  ended?: LangfuseToolObservationEnd;

  constructor(
    readonly name: string,
    readonly input: unknown,
    readonly metadata: unknown,
  ) {}

  event(body: LangfuseToolObservationEvent): unknown {
    this.events.push(body);
    return this;
  }

  end(body?: LangfuseToolObservationEnd): unknown {
    if (body !== undefined) this.ended = body;
    return this;
  }
}

class FakeParent implements LangfuseToolObservationParent {
  readonly spans: FakeSpan[] = [];

  span(body: Parameters<LangfuseToolObservationParent["span"]>[0]): LangfuseToolObservation {
    const span = new FakeSpan(body.name, body.input, body.metadata);
    this.spans.push(span);
    return span;
  }
}

describe("langfuse observability", () => {
  it("wraps tool execution in a child span without storing raw opaque text", async () => {
    const parameters = Type.Object({ path: Type.String(), contents: Type.String() });
    const tool: AgentTool<typeof parameters, { text: string }> = {
      name: "workspace_write",
      label: "Write Workspace File",
      description: "Write a file",
      parameters,
      execute: async (_toolCallId, params, _signal, onUpdate) => {
        onUpdate?.({
          content: [{ type: "text", text: "partial secret" }],
          details: { text: "partial secret" },
        });
        return {
          content: [{ type: "text", text: `wrote ${params.contents}` }],
          details: { text: params.contents },
        };
      },
    };
    const parent = new FakeParent();
    const [instrumented] = instrumentToolsForLangfuse([tool], parent);
    if (!instrumented) throw new Error("instrumented tool missing");

    await instrumented.execute(
      "call-1",
      { path: "memory/MEMORY.md", contents: "do not store this body" },
      undefined,
      () => {},
    );

    expect(parent.spans).toHaveLength(1);
    const [span] = parent.spans;
    if (!span) throw new Error("span missing");
    expect(span.name).toBe("tool:workspace_write");
    expect(span.input).toMatchObject({
      path: "memory/MEMORY.md",
      contents: { type: "string", length: 22 },
    });
    expect(span.ended).toMatchObject({
      level: "DEFAULT",
      output: {
        textPartCount: 1,
        textLength: 28,
        details: { text: { type: "string", length: 22 } },
      },
    });
    expect(span.events).toHaveLength(1);
  });

  it("marks tool spans as errors when execution throws", async () => {
    const parameters = Type.Object({ query: Type.String() });
    const tool: AgentTool<typeof parameters, never> = {
      name: "search_internet",
      label: "Search Internet",
      description: "Search",
      parameters,
      execute: async () => {
        throw new Error("network unavailable");
      },
    };
    const parent = new FakeParent();
    const [instrumented] = instrumentToolsForLangfuse([tool], parent);
    if (!instrumented) throw new Error("instrumented tool missing");

    await expect(instrumented.execute("call-2", { query: "langfuse" })).rejects.toThrow(
      /network unavailable/,
    );

    const [span] = parent.spans;
    if (!span) throw new Error("span missing");
    expect(span.ended).toMatchObject({
      level: "ERROR",
      statusMessage: "network unavailable",
      output: { name: "Error", message: "network unavailable" },
    });
  });
});
