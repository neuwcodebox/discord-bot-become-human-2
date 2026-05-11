import type { AppConfig, ConversationRuntimeState, NormalizedDiscordMessage } from "../types.js";

export type ReplyGateResult = { allowed: true } | { allowed: false; reason: string };

export function checkReplyHardGates(
  config: AppConfig,
  state: ConversationRuntimeState,
  message: NormalizedDiscordMessage,
  options: { unprompted: boolean; botUserId?: string | undefined; botNames?: string[] },
): ReplyGateResult {
  const now = Date.now();
  const directedAtBot = isDirectedAtBot(message, options.botUserId, options.botNames);
  if (state.cooldownUntil && Date.parse(state.cooldownUntil) > now) {
    return { allowed: false, reason: "cooldownUntil is active" };
  }
  if (state.lastBotMessageAt) {
    const sinceBot = (now - Date.parse(state.lastBotMessageAt)) / 1000;
    if (sinceBot < config.conversation.engaged.minSecondsBetweenBotReplies) {
      return { allowed: false, reason: "minSecondsBetweenBotReplies gate" };
    }
    if (options.unprompted && sinceBot < config.conversation.engaged.minSecondsBetweenUnpromptedReplies) {
      return { allowed: false, reason: "minSecondsBetweenUnpromptedReplies gate" };
    }
  }
  if (state.consecutiveBotReplies >= config.conversation.engaged.maxConsecutiveBotReplies && !directedAtBot) {
    return { allowed: false, reason: "maxConsecutiveBotReplies gate" };
  }
  return { allowed: true };
}

export function noteBotReply(config: AppConfig, state: ConversationRuntimeState, messageId: string): void {
  const now = new Date();
  state.lastBotMessageAt = now.toISOString();
  state.recentBotMessageIds = [...state.recentBotMessageIds.slice(-20), messageId];
  state.consecutiveBotReplies += 1;
  state.humanMessagesSinceLastBot = 0;
  state.unrelatedHumanMessagesSinceLastBot = 0;
  const [min, max] = config.conversation.cooldownMs;
  const cooldown = min === max ? min : min + Math.floor(Math.random() * (max - min));
  state.cooldownUntil = new Date(now.getTime() + cooldown).toISOString();
}

export function noteHumanMessage(state: ConversationRuntimeState, relatedToBot: boolean): void {
  state.lastHumanMessageAt = new Date().toISOString();
  state.humanMessagesSinceLastBot += 1;
  if (!relatedToBot) state.unrelatedHumanMessagesSinceLastBot += 1;
  state.consecutiveBotReplies = 0;
}

export function isDirectedAtBot(
  message: NormalizedDiscordMessage,
  botUserId?: string,
  botNames: string[] = [],
): boolean {
  if (botUserId && message.mentions.some((mention) => mention.id === botUserId)) return true;
  const lower = message.cleanContent.toLowerCase();
  return botNames.some((name) => lower.includes(name.toLowerCase()));
}
