import type { DecisionContextInput } from "../agent/context-builder.js";
import { buildEngagementDecisionContext } from "../agent/context-builder.js";
import type { AgentRunner } from "../agent/runner.js";
import type { EngagementDecision, NormalizedDiscordMessage } from "../types.js";
import { engagementDecisionSchema, parseDecisionJson } from "./decision-schema.js";

export async function decideEngagement(
  input: DecisionContextInput & { runner: AgentRunner },
): Promise<EngagementDecision> {
  const messages = await buildEngagementDecisionContext(input);
  const result = await input.runner.run({
    sessionId: `decision:${input.currentMessage.guildId}:${input.currentMessage.channelId}`,
    messages,
    traceLabel: "engagement_decision",
  });
  return engagementDecisionSchema.parse(parseDecisionJson(result.text));
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
