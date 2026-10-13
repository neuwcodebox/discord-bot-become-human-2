import type { DecisionContextInput } from "../agent/context-builder.js";
import { buildStayDecisionContext } from "../agent/context-builder.js";
import type { AgentRunner } from "../agent/runner.js";
import type { StayDecision } from "../types.js";
import { parseDecisionJson, stayDecisionSchema } from "./decision-schema.js";

export async function decideStay(
  input: DecisionContextInput & { runner: AgentRunner },
): Promise<StayDecision> {
  const messages = await buildStayDecisionContext(input);
  const result = await input.runner.run({
    sessionId: `stay:${input.currentMessage.guildId}:${input.currentMessage.channelId}`,
    messages,
    traceLabel: "stay_decision",
  });
  return stayDecisionSchema.parse(parseDecisionJson(result.text));
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
