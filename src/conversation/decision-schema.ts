import { z } from "zod";

export const engagementDecisionSchema = z.object({
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

export const stayDecisionSchema = z.object({
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

export type EngagementDecision = z.infer<typeof engagementDecisionSchema>;
export type StayDecision = z.infer<typeof stayDecisionSchema>;

export function parseDecisionJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return JSON.parse(fenced?.[1] ?? trimmed);
}
