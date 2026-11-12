import { z } from "zod";
import type { AgentContextMessage } from "../types.js";

const payloadSchema = z.object({ input: z.array(z.unknown()) }).passthrough();
const textBlockSchema = z.object({ type: z.literal("input_text"), text: z.string() }).passthrough();
const messageSchema = z
  .object({
    role: z.enum(["system", "developer", "user"]),
    content: z.union([z.string(), z.array(textBlockSchema)]),
  })
  .passthrough();

/** Keep the explicit fixed prefix in addition to automatic history/tool boundaries.
 * Validate developer task placement after SDK serialization, including tool continuations.
 */
export function createPromptCachePayloadAdapter(
  messages: AgentContextMessage[],
  systemPrompt: string,
): (payload: unknown) => unknown {
  const prompts = messages.filter((message) => message.role === "user" || message.role === "developer");
  const offset = systemPrompt.length > 0 ? 1 : 0;
  const markPrefix = messages.some((message) => message.role === "system" && message.cacheBreakpoint);
  return (payload) => {
    const parsed = payloadSchema.parse(payload);
    const input = parsed.input.slice();
    if (markPrefix && systemPrompt) {
      const fixed = messageSchema.parse(input[0]);
      if (fixed.role !== "developer" || fixed.content !== systemPrompt) {
        throw new Error("Unexpected Responses instruction serialization");
      }
      input[0] = {
        ...fixed,
        content: [{ type: "input_text", text: systemPrompt, prompt_cache_breakpoint: { mode: "explicit" } }],
      };
    }
    for (const [index, prompt] of prompts.entries()) {
      if (prompt.role !== "developer") continue;
      const item = messageSchema.parse(input[index + offset]);
      const text =
        typeof item.content === "string" ? item.content : item.content.map((part) => part.text).join("");
      if (item.role !== "developer" || text !== prompt.content) {
        throw new Error("Unexpected Responses task serialization");
      }
    }
    // Keep implicit history/tool boundaries as well as the explicit fixed prefix.
    // Leave TTL at the API default and retain the SDK's existing session cache key.
    const { prompt_cache_retention: _legacyRetention, ...rest } = parsed;
    return { ...rest, input, prompt_cache_options: { mode: "implicit" } };
  };
}
