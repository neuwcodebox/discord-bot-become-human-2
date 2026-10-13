import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { TSchema } from "@earendil-works/pi-ai";
import { childLogger } from "../logger.js";

const log = childLogger("tools");

export function defineTool<TParameters extends TSchema, TDetails>(
  tool: AgentTool<TParameters, TDetails>,
): AgentTool<TParameters, TDetails> {
  return {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const startedAt = Date.now();
      log.debug(
        { toolName: tool.name, toolCallId, paramKeys: Object.keys(params) },
        "tool execution started",
      );
      try {
        signal?.throwIfAborted();
        const result = await tool.execute(toolCallId, params, signal, onUpdate);
        signal?.throwIfAborted();
        log.debug(
          {
            toolName: tool.name,
            toolCallId,
            durationMs: Date.now() - startedAt,
            isError: false,
          },
          "tool execution completed",
        );
        return result;
      } catch (error) {
        log.warn(
          {
            err: error,
            toolName: tool.name,
            toolCallId,
            durationMs: Date.now() - startedAt,
          },
          "tool execution failed",
        );
        throw error;
      }
    },
  };
}

export function jsonResult(value: unknown): AgentToolResult<{ text: string }> {
  const text = JSON.stringify(value, null, 2);
  return {
    content: [{ type: "text", text }],
    details: { text },
  };
}
