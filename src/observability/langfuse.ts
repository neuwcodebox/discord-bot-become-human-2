import type { AgentMessage, AgentToolResult } from "@earendil-works/pi-agent-core";
import { truncateText } from "../context/limits.js";
import type { RuntimeAgentTool } from "../types.js";

const MAX_CAPTURED_STRING_CHARS = 500;
const MAX_CAPTURED_ARRAY_ITEMS = 10;
const MAX_CAPTURED_OBJECT_KEYS = 20;
const MAX_CAPTURED_DEPTH = 4;
const MAX_TOOL_UPDATE_EVENTS = 5;

type ObservationLevel = "DEFAULT" | "ERROR";

export type LangfuseToolObservationEnd = {
  output?: unknown;
  metadata?: unknown;
  level?: ObservationLevel;
  statusMessage?: string;
};

export type LangfuseToolObservationEvent = {
  name: string;
  output?: unknown;
  metadata?: unknown;
};

export type LangfuseToolObservation = {
  event(body: LangfuseToolObservationEvent): unknown;
  end(body?: LangfuseToolObservationEnd): unknown;
};

export type LangfuseToolObservationParent = {
  span(body: {
    name: string;
    startTime?: Date;
    input?: unknown;
    metadata?: unknown;
  }): LangfuseToolObservation;
};

export function instrumentToolsForLangfuse(
  tools: RuntimeAgentTool[],
  parent: LangfuseToolObservationParent | null | undefined,
): RuntimeAgentTool[] {
  if (!parent || tools.length === 0) return tools;
  return tools.map((tool) => ({
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const startedAt = Date.now();
      const metadata: Record<string, unknown> = {
        toolName: tool.name,
        toolLabel: tool.label,
        toolCallId,
        langfuseObservationType: "tool",
        paramKeys: recordKeys(params),
        capturedStringLimitChars: MAX_CAPTURED_STRING_CHARS,
      };
      const span = safeStartToolSpan(parent, {
        name: `tool:${tool.name}`,
        startTime: new Date(startedAt),
        input: summarizeToolInput(tool.name, params),
        metadata,
      });

      let updateCount = 0;
      const tracedOnUpdate =
        onUpdate === undefined
          ? undefined
          : (partialResult: AgentToolResult<unknown>) => {
              updateCount += 1;
              if (span && updateCount <= MAX_TOOL_UPDATE_EVENTS) {
                safeEvent(span, {
                  name: "tool_update",
                  output: summarizeToolResult(partialResult),
                  metadata: { toolName: tool.name, toolCallId, sequence: updateCount },
                });
              }
              onUpdate(partialResult);
            };

      try {
        const result = await tool.execute(toolCallId, params, signal, tracedOnUpdate);
        safeEnd(span, {
          output: summarizeToolResult(result),
          level: "DEFAULT",
          metadata: {
            ...metadata,
            durationMs: Date.now() - startedAt,
            updateCount,
            updateEventsCaptured: Math.min(updateCount, MAX_TOOL_UPDATE_EVENTS),
          },
        });
        return result;
      } catch (error) {
        const errorSummary = summarizeError(error);
        safeEnd(span, {
          output: errorSummary,
          level: "ERROR",
          statusMessage: errorSummary.message,
          metadata: {
            ...metadata,
            durationMs: Date.now() - startedAt,
            updateCount,
            updateEventsCaptured: Math.min(updateCount, MAX_TOOL_UPDATE_EVENTS),
          },
        });
        throw error;
      }
    },
  }));
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

function safeStartToolSpan(
  parent: LangfuseToolObservationParent,
  body: Parameters<LangfuseToolObservationParent["span"]>[0],
): LangfuseToolObservation | null {
  try {
    return parent.span(body);
  } catch {
    return null;
  }
}

function safeEvent(span: LangfuseToolObservation, body: LangfuseToolObservationEvent): void {
  try {
    span.event(body);
  } catch {
    // Observability must never change tool behavior.
  }
}

function safeEnd(span: LangfuseToolObservation | null, body: LangfuseToolObservationEnd): void {
  if (!span) return;
  try {
    span.end(body);
  } catch {
    // Observability must never change tool behavior.
  }
}

function summarizeToolInput(toolName: string, params: unknown): unknown {
  if (!isRecord(params)) return sanitizeValue(params);

  if (toolName === "workspace_write") {
    return summarizeKnownParams(params, ["path"], ["contents"]);
  }
  if (toolName === "discord_send_message") {
    return summarizeKnownParams(params, [], ["content"]);
  }
  if (toolName === "discord_edit_own") {
    return summarizeKnownParams(params, ["messageId"], ["content"]);
  }
  if (toolName === "summarize_text") {
    return summarizeKnownParams(params, ["maxChars"], ["text"]);
  }
  if (toolName === "memory_propose") {
    return summarizeKnownParams(params, ["target", "confidence", "evidenceMessageIds"], ["note"]);
  }

  return sanitizeValue(params);
}

function summarizeKnownParams(
  params: Record<string, unknown>,
  visibleKeys: string[],
  sizeOnlyKeys: string[],
): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (const key of visibleKeys) {
    if (key in params) summary[key] = sanitizeValue(params[key], key);
  }
  for (const key of sizeOnlyKeys) {
    if (key in params) summary[key] = summarizeOpaqueText(params[key]);
  }
  return summary;
}

function summarizeToolResult(result: AgentToolResult<unknown>): Record<string, unknown> {
  let textPartCount = 0;
  let imagePartCount = 0;
  let textLength = 0;

  for (const part of result.content) {
    if (part.type === "text") {
      textPartCount += 1;
      textLength += part.text.length;
    } else {
      imagePartCount += 1;
    }
  }

  const summary: Record<string, unknown> = {
    contentPartCount: result.content.length,
    textPartCount,
    imagePartCount,
    textLength,
    details: sanitizeValue(result.details, "details"),
  };
  if (result.terminate !== undefined) summary.terminate = result.terminate;
  return summary;
}

function sanitizeValue(value: unknown, key?: string, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null) return null;
  if (value === undefined) return { type: "undefined" };
  if (typeof value === "string") return sanitizeString(value, key);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();

  if (Array.isArray(value)) {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    const items = value
      .slice(0, MAX_CAPTURED_ARRAY_ITEMS)
      .map((item) => sanitizeValue(item, key, depth + 1, seen));
    if (value.length <= MAX_CAPTURED_ARRAY_ITEMS) return items;
    return { items, totalItems: value.length, truncatedItems: value.length - MAX_CAPTURED_ARRAY_ITEMS };
  }

  if (!isRecord(value)) return { type: typeof value };
  if (seen.has(value)) return "[Circular]";
  if (depth >= MAX_CAPTURED_DEPTH) return { type: "object", keyCount: Object.keys(value).length };

  seen.add(value);
  const entries = Object.entries(value).slice(0, MAX_CAPTURED_OBJECT_KEYS);
  const result: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of entries) {
    result[entryKey] = sanitizeValue(entryValue, entryKey, depth + 1, seen);
  }
  const keyCount = Object.keys(value).length;
  if (keyCount > MAX_CAPTURED_OBJECT_KEYS) {
    result.truncatedKeys = keyCount - MAX_CAPTURED_OBJECT_KEYS;
  }
  return result;
}

function sanitizeString(value: string, key?: string): unknown {
  if (key && isSensitiveKey(key)) return "[REDACTED]";
  if (key && isOpaqueTextKey(key)) return summarizeOpaqueText(value);
  const capped = truncateText(value, MAX_CAPTURED_STRING_CHARS);
  if (!capped.truncated) return value;
  return { preview: capped.text, length: value.length, truncated: true };
}

function summarizeOpaqueText(value: unknown): unknown {
  if (typeof value !== "string") return sanitizeValue(value);
  return { type: "string", length: value.length };
}

function recordKeys(value: unknown): string[] {
  if (!isRecord(value)) return [];
  return Object.keys(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function isOpaqueTextKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return (
    normalized === "content" ||
    normalized === "contents" ||
    normalized === "text" ||
    normalized === "note" ||
    normalized === "systemprompt" ||
    normalized === "prompt"
  );
}

function summarizeError(error: unknown): { name?: string; message: string } {
  if (error instanceof Error) {
    const summary: { name?: string; message: string } = { message: error.message };
    if (error.name) summary.name = error.name;
    return summary;
  }
  return { message: String(error) };
}
