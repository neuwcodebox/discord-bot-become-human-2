import { z } from "zod";
import { buildStayDecisionContext } from "../agent/context-builder.js";
import type { AgentRunner } from "../agent/runner.js";
import type {
  ConversationRuntimeState,
  NormalizedDiscordEvent,
  NormalizedDiscordMessage,
  StayDecision,
} from "../types.js";

const schema: z.ZodType<StayDecision> = z.object({
  stayEngaged: z.boolean(),
  action: z.enum(["reply", "wait", "silent_track", "react", "disengage"]),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
  attention: z.enum(["directed_at_bot", "bot_relevant", "human_to_human", "background", "topic_changed"]),
  targetMessageIds: z.array(z.string()),
  reactionHint: z.enum(["ack", "thanks", "funny", "agree", "care", "surprised"]).optional(),
  replyPriority: z.enum(["urgent", "normal", "low", "none"]),
  disengageReason: z
    .enum([
      "conversation_ended",
      "topic_moved_without_bot",
      "bot_not_needed",
      "too_many_bot_turns",
      "idle_timeout",
      "uncertain",
    ])
    .optional(),
});

export async function decideStay(input: {
  runner: AgentRunner;
  agentsPath: string;
  workspaceRoot: string;
  state: ConversationRuntimeState;
  events: NormalizedDiscordEvent[];
  currentMessage: NormalizedDiscordMessage;
  timezone?: string;
}): Promise<StayDecision> {
  const messages = await buildStayDecisionContext(input);
  const result = await input.runner.run({
    sessionId: `stay:${input.currentMessage.guildId}:${input.currentMessage.channelId}`,
    messages,
    traceLabel: "stay_decision",
  });
  return schema.parse(parseJson(result.text));
}

export function forcedSilentStay(reason: string, currentMessageId: string): StayDecision {
  return {
    stayEngaged: true,
    action: "silent_track",
    confidence: 1,
    reason,
    attention: "background",
    targetMessageIds: [currentMessageId],
    replyPriority: "none",
  };
}

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return JSON.parse(fenced?.[1] ?? trimmed);
}
