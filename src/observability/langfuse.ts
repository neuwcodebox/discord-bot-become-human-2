import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentContextMessage } from "../types.js";

const MAX_UPDATE_EVENTS_PER_TOOL = 5;

type ObservationLevel = "DEFAULT" | "ERROR";

export type LangfuseScoreBody = {
  name: string;
  value: number;
  traceId?: string;
  observationId?: string;
};

export type LangfuseEventBody = {
  name: string;
  output?: unknown;
  metadata?: Record<string, unknown>;
};

export type LangfuseSpanEndBody = {
  output?: unknown;
  metadata?: Record<string, unknown>;
  level?: ObservationLevel;
  statusMessage?: string;
};

export type LangfuseGenerationEndBody = {
  output?: unknown;
  metadata?: Record<string, unknown>;
  usage?: Record<string, number>;
  costDetails?: Record<string, number>;
};

export type LangfuseSpan = {
  id: string;
  event(body: LangfuseEventBody): unknown;
  end(body?: LangfuseSpanEndBody): unknown;
};

export type LangfuseGeneration = {
  id: string;
  end(body?: LangfuseGenerationEndBody): unknown;
};

export type LangfuseTrace = {
  id: string;
  update(body?: { input?: unknown; output?: unknown; metadata?: Record<string, unknown> }): unknown;
  span(body: {
    name: string;
    startTime?: Date;
    input?: unknown;
    metadata?: Record<string, unknown>;
  }): LangfuseSpan;
  generation(body: {
    name: string;
    startTime?: Date;
    input?: unknown;
    output?: unknown;
    metadata?: Record<string, unknown>;
    model?: string;
    usage?: Record<string, number>;
    costDetails?: Record<string, number>;
  }): LangfuseGeneration;
};

export type LangfuseAgentClient = {
  trace(body?: {
    name?: string;
    timestamp?: Date;
    sessionId?: string;
    input?: unknown;
    output?: unknown;
    metadata?: Record<string, unknown>;
  }): LangfuseTrace;
  score(body: LangfuseScoreBody): unknown;
};

export type LangfuseAgentObserverOptions = {
  langfuse: LangfuseAgentClient;
  traceLabel?: string;
  sessionId: string;
  model: string;
  provider: string;
  systemPrompt?: string;
  inputMessages: AgentContextMessage[];
  getGenerationMessages?: () => AgentMessage[] | undefined;
  startedAt: number;
};

export type LangfuseAgentObserver = {
  handleEvent(event: AgentEvent): Promise<void>;
  finish(finalText: string, messages: AgentMessage[]): void;
};

type ActiveToolSpan = {
  span: LangfuseSpan;
  toolName: string;
  toolCallId: string;
  updateCount: number;
  startOrder: number;
};

type ActiveGeneration = {
  generation: LangfuseGeneration;
  turnIndex: number;
  startOrder: number;
};

type AssistantGenerationOutput =
  | string
  | {
      text?: string;
      toolCalls: Array<{
        id: string;
        name: string;
        arguments: string;
      }>;
    };

export function createLangfuseAgentObserver(options: LangfuseAgentObserverOptions): LangfuseAgentObserver {
  const inputMessages = summarizeInputMessages(options.inputMessages);
  const initialGenerationInput = generationInputFromContextMessages(inputMessages);
  const trace = options.langfuse.trace({
    name: options.traceLabel ?? "agent-run",
    timestamp: new Date(options.startedAt),
    sessionId: options.sessionId,
    input: inputMessages,
    metadata: {
      model: options.model,
      provider: options.provider,
      messageCount: options.inputMessages.length,
    },
  });

  const activeToolSpans = new Map<string, ActiveToolSpan>();
  let activeGeneration: ActiveGeneration | null = null;
  let eventOrder = 0;
  let toolCallCount = 0;
  let errorCount = 0;
  let turnCount = 0;
  let completed = false;

  function nextOrder(): number {
    eventOrder += 1;
    return eventOrder;
  }

  function handleMessageStart(event: Extract<AgentEvent, { type: "message_start" }>): void {
    if (event.message.role !== "assistant") return;
    const order = nextOrder();
    activeGeneration = {
      generation: trace.generation({
        name: "llm-response",
        startTime: new Date(),
        input: currentGenerationInput(),
        model: event.message.model || options.model,
        metadata: {
          provider: event.message.provider || options.provider,
          turnIndex: turnCount + 1,
          eventOrder: order,
        },
      }),
      turnIndex: turnCount + 1,
      startOrder: order,
    };
  }

  function currentGenerationInput(): unknown {
    try {
      const messages = options.getGenerationMessages?.();
      if (messages) return summarizeGenerationInput(options.systemPrompt, messages);
    } catch {
      // Observability must never change agent behavior.
    }
    return initialGenerationInput;
  }

  function handleMessageEnd(event: Extract<AgentEvent, { type: "message_end" }>): void {
    if (event.message.role !== "assistant") return;
    const generation = activeGeneration;
    if (!generation) return;
    const usage = usageDetails(event.message);
    const costDetails = costDetailsFromUsage(event.message.usage);
    const toolCalls = extractToolCalls(event.message.content);
    const endBody: LangfuseGenerationEndBody = {
      output: assistantGenerationOutput(event.message.content),
      metadata: {
        provider: event.message.provider || options.provider,
        stopReason: event.message.stopReason,
        turnIndex: generation.turnIndex,
        startOrder: generation.startOrder,
        endOrder: nextOrder(),
        toolCallCount: toolCalls.length,
        toolCallNames: toolCalls.map((part) => part.name),
      },
      usage,
    };
    if (costDetails) endBody.costDetails = costDetails;
    generation.generation.end(endBody);
    activeGeneration = null;
  }

  function handleToolStart(event: Extract<AgentEvent, { type: "tool_execution_start" }>): void {
    const order = nextOrder();
    toolCallCount += 1;
    const span = trace.span({
      name: `tool:${event.toolName}`,
      startTime: new Date(),
      input: safeSerialize(event.args),
      metadata: {
        tool: event.toolName,
        toolCallId: event.toolCallId,
        eventOrder: order,
      },
    });
    activeToolSpans.set(event.toolCallId, {
      span,
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      updateCount: 0,
      startOrder: order,
    });
  }

  function handleToolUpdate(event: Extract<AgentEvent, { type: "tool_execution_update" }>): void {
    const spanData = activeToolSpans.get(event.toolCallId);
    if (!spanData) return;
    spanData.updateCount += 1;
    if (spanData.updateCount > MAX_UPDATE_EVENTS_PER_TOOL) return;
    spanData.span.event({
      name: "tool_update",
      output: summarizeToolResult(event.partialResult),
      metadata: {
        tool: event.toolName,
        toolCallId: event.toolCallId,
        sequence: spanData.updateCount,
        eventOrder: nextOrder(),
      },
    });
  }

  function handleToolEnd(event: Extract<AgentEvent, { type: "tool_execution_end" }>): void {
    const spanData = activeToolSpans.get(event.toolCallId);
    if (!spanData) return;
    if (event.isError) {
      errorCount += 1;
      safeScore(options.langfuse, {
        name: "tool_is_error",
        value: 1,
        traceId: trace.id,
        observationId: spanData.span.id,
      });
    }
    const endBody: LangfuseSpanEndBody = {
      output: summarizeToolResult(event.result),
      level: event.isError ? "ERROR" : "DEFAULT",
      metadata: {
        tool: spanData.toolName,
        toolCallId: spanData.toolCallId,
        isError: event.isError,
        startOrder: spanData.startOrder,
        endOrder: nextOrder(),
        updateCount: spanData.updateCount,
        updateEventsCaptured: Math.min(spanData.updateCount, MAX_UPDATE_EVENTS_PER_TOOL),
      },
    };
    if (event.isError) {
      const statusMessage = extractToolStatusMessage(event.result);
      if (statusMessage !== undefined) endBody.statusMessage = statusMessage;
    }
    spanData.span.end(endBody);
    activeToolSpans.delete(event.toolCallId);
  }

  function handleTurnEnd(event: Extract<AgentEvent, { type: "turn_end" }>): void {
    turnCount += 1;
    if (event.message.role === "assistant" && activeGeneration) {
      handleMessageEnd({ type: "message_end", message: event.message });
    }
  }

  function complete(finalText: string, messages: AgentMessage[]): void {
    if (completed) return;
    completed = true;
    for (const spanData of activeToolSpans.values()) {
      spanData.span.end({
        level: "ERROR",
        statusMessage: "tool span was still active when agent ended",
        metadata: {
          tool: spanData.toolName,
          toolCallId: spanData.toolCallId,
          startOrder: spanData.startOrder,
          endOrder: nextOrder(),
          updateCount: spanData.updateCount,
          incomplete: true,
        },
      });
    }
    activeToolSpans.clear();

    const toolActivity = summarizeAgentToolActivity(messages);
    const scores = computeEvaluationScores(toolCallCount, errorCount, turnCount);
    trace.update({
      output: finalText,
      metadata: {
        completed: true,
        model: options.model,
        provider: options.provider,
        eventCount: eventOrder,
        ...toolActivity,
        ...scores,
      },
    });
    safeScore(options.langfuse, {
      name: "tool_call_count",
      value: scores.tool_call_count,
      traceId: trace.id,
    });
    safeScore(options.langfuse, { name: "turn_count", value: scores.turn_count, traceId: trace.id });
    safeScore(options.langfuse, {
      name: "total_tool_errors",
      value: scores.total_tool_errors,
      traceId: trace.id,
    });
    safeScore(options.langfuse, {
      name: "tool_success_rate",
      value: scores.tool_success_rate,
      traceId: trace.id,
    });
    safeScore(options.langfuse, {
      name: "session_had_errors",
      value: scores.session_had_errors,
      traceId: trace.id,
    });
  }

  return {
    async handleEvent(event) {
      try {
        switch (event.type) {
          case "message_start":
            handleMessageStart(event);
            break;
          case "message_end":
            handleMessageEnd(event);
            break;
          case "tool_execution_start":
            handleToolStart(event);
            break;
          case "tool_execution_update":
            handleToolUpdate(event);
            break;
          case "tool_execution_end":
            handleToolEnd(event);
            break;
          case "turn_end":
            handleTurnEnd(event);
            break;
          case "agent_end":
            complete(extractFinalAssistantText(event.messages), event.messages);
            break;
        }
      } catch {
        // Observability must never change agent behavior.
      }
    },
    finish: complete,
  };
}

export function summarizeAgentToolActivity(messages: AgentMessage[]): Record<string, unknown> {
  const toolCallNames = new Set<string>();
  const toolResultNames = new Set<string>();
  let toolCallCount = 0;
  let toolResultCount = 0;
  let toolErrorCount = 0;

  for (const message of messages) {
    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type !== "toolCall") continue;
        toolCallCount += 1;
        toolCallNames.add(part.name);
      }
      continue;
    }
    if (message.role !== "toolResult") continue;
    toolResultCount += 1;
    toolResultNames.add(message.toolName);
    if (message.isError) toolErrorCount += 1;
  }

  return {
    toolCallCount,
    toolResultCount,
    toolErrorCount,
    toolCallNames: Array.from(toolCallNames),
    toolResultNames: Array.from(toolResultNames),
  };
}

function summarizeInputMessages(messages: AgentContextMessage[]): Array<Record<string, unknown>> {
  return messages.map((message) => ({
    role: message.role,
    content: message.content,
    contentLength: message.content.length,
  }));
}

function generationInputFromContextMessages(
  messages: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return messages.map((message) => ({ ...message }));
}

function summarizeGenerationInput(
  systemPrompt: string | undefined,
  messages: AgentMessage[],
): Array<Record<string, unknown>> {
  const input: Array<Record<string, unknown>> = [];
  if (systemPrompt && systemPrompt.length > 0) {
    input.push({ role: "system", content: systemPrompt, contentLength: systemPrompt.length });
  }
  for (const message of messages) {
    input.push(summarizeAgentMessageInput(message));
  }
  return input;
}

function summarizeAgentMessageInput(message: AgentMessage): Record<string, unknown> {
  switch (message.role) {
    case "user": {
      const content = summarizeMessageContent(message.content);
      return {
        role: "user",
        content,
        contentLength: summarizedContentLength(content),
      };
    }
    case "assistant":
      return {
        role: "assistant",
        content: assistantGenerationOutput(message.content),
        stopReason: message.stopReason,
        model: message.model,
      };
    case "toolResult": {
      const content = summarizeMessageContent(message.content);
      return {
        role: "toolResult",
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        isError: message.isError,
        content,
        contentLength: summarizedContentLength(content),
      };
    }
  }
}

function summarizeMessageContent(
  content:
    | Extract<AgentMessage, { role: "user" }>["content"]
    | Extract<AgentMessage, { role: "toolResult" }>["content"],
): unknown {
  if (typeof content === "string") return content;
  return content.map((part) => {
    if (part.type === "text") {
      return { type: "text", text: part.text, contentLength: part.text.length };
    }
    return { type: "image", mimeType: part.mimeType, dataLength: part.data.length };
  });
}

function summarizedContentLength(content: unknown): number {
  if (typeof content === "string") return content.length;
  return safeSerialize(content).length;
}

function extractFinalAssistantText(messages: AgentMessage[]): string {
  const assistant = messages.findLast((message): message is Extract<AgentMessage, { role: "assistant" }> => {
    return message.role === "assistant";
  });
  return assistant ? extractTextContent(assistant.content) : "";
}

function extractTextContent(content: Array<{ type: string; text?: string }> | undefined): string {
  if (!content?.length) return "";
  return content
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
}

function assistantGenerationOutput(
  content: Extract<AgentMessage, { role: "assistant" }>["content"],
): AssistantGenerationOutput {
  const text = extractTextContent(content);
  const toolCalls = extractToolCalls(content).map((part) => ({
    id: part.id,
    name: part.name,
    arguments: safeSerialize(part.arguments),
  }));
  if (toolCalls.length === 0) return text;
  return text.length > 0 ? { text, toolCalls } : { toolCalls };
}

function extractToolCalls(
  content: Extract<AgentMessage, { role: "assistant" }>["content"],
): Array<Extract<Extract<AgentMessage, { role: "assistant" }>["content"][number], { type: "toolCall" }>> {
  return content.filter(
    (
      part,
    ): part is Extract<
      Extract<AgentMessage, { role: "assistant" }>["content"][number],
      { type: "toolCall" }
    > => part.type === "toolCall",
  );
}

function summarizeToolResult(result: unknown): string {
  if (!isRecord(result)) return safeSerialize(result);
  const content = result.content;
  if (Array.isArray(content)) {
    const text = content
      .filter(isTextContent)
      .map((item) => item.text)
      .join("\n");
    if (text) return text;
  }
  return safeSerialize(result);
}

function extractToolStatusMessage(result: unknown): string | undefined {
  const text = summarizeToolResult(result);
  return text || undefined;
}

function usageDetails(message: Extract<AgentMessage, { role: "assistant" }>): Record<string, number> {
  return {
    input: message.usage.input || 0,
    output: message.usage.output || 0,
    total: message.usage.totalTokens || (message.usage.input || 0) + (message.usage.output || 0),
  };
}

function costDetailsFromUsage(
  usage: Extract<AgentMessage, { role: "assistant" }>["usage"],
): Record<string, number> | undefined {
  const cost = usage.cost;
  if (!cost) return undefined;
  return {
    total: cost.total,
    input: cost.input,
    output: cost.output,
    cacheRead: cost.cacheRead,
    cacheWrite: cost.cacheWrite,
  };
}

function computeEvaluationScores(toolCallCount: number, errorCount: number, turnCount: number) {
  return {
    tool_call_count: toolCallCount,
    turn_count: turnCount,
    total_tool_errors: errorCount,
    tool_success_rate: toolCallCount > 0 ? (toolCallCount - errorCount) / toolCallCount : 1,
    session_had_errors: errorCount > 0 ? 1 : 0,
  };
}

function safeSerialize(value: unknown): string {
  try {
    return JSON.stringify(value, redactingReplacer, 2);
  } catch {
    return `[unserializable ${typeof value}]`;
  }
}

function redactingReplacer(key: string, value: unknown): unknown {
  if (key && isSensitiveKey(key)) return "[REDACTED]";
  if (typeof value === "bigint") return value.toString();
  return value;
}

function safeScore(langfuse: LangfuseAgentClient, body: LangfuseScoreBody): void {
  try {
    langfuse.score(body);
  } catch {
    // Observability must never change agent behavior.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTextContent(value: unknown): value is { type: "text"; text: string } {
  return isRecord(value) && value.type === "text" && typeof value.text === "string";
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return (
    normalized.includes("token") ||
    normalized.includes("secret") ||
    normalized.includes("password") ||
    normalized.includes("authorization") ||
    normalized.includes("apikey") ||
    normalized.includes("api_key") ||
    normalized.includes("refresh")
  );
}
