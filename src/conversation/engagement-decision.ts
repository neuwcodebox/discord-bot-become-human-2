import { z } from "zod";
import { buildEngagementDecisionContext } from "../agent/context-builder.js";
import type { AgentRunner } from "../agent/runner.js";
import type {
  BotIdentity,
  ConversationRuntimeState,
  EngagementDecision,
  NormalizedDiscordEvent,
  NormalizedDiscordMessage,
} from "../types.js";

const schema: z.ZodType<EngagementDecision> = z.object({
  engage: z.boolean(),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
  targetMessageIds: z.array(z.string()),
  expectedRole: z.enum([
    "answer_question",
    "join_casually",
    "handle_attachment",
    "clarify",
    "react_only",
    "other",
  ]),
});

export async function decideEngagement(input: {
  runner: AgentRunner;
  agentsPath: string;
  workspaceRoot: string;
  state: ConversationRuntimeState;
  events: NormalizedDiscordEvent[];
  currentMessage: NormalizedDiscordMessage;
  timezone?: string;
  botIdentity: BotIdentity;
}): Promise<EngagementDecision> {
  const messages = await buildEngagementDecisionContext(input);
  const result = await input.runner.run({
    sessionId: `decision:${input.currentMessage.guildId}:${input.currentMessage.channelId}`,
    messages,
    traceLabel: "engagement_decision",
  });
  return schema.parse(parseJson(result.text));
}

export function directEngagementDecision(
  message: NormalizedDiscordMessage,
  reason: string,
): EngagementDecision {
  return {
    engage: true,
    confidence: 1,
    reason,
    targetMessageIds: [message.id],
    expectedRole: message.attachments.length > 0 ? "handle_attachment" : "answer_question",
  };
}

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return JSON.parse(fenced?.[1] ?? trimmed);
}
