import type { ConversationRuntimeState } from "../types.js";

export function conversationId(input: { guildId: string; channelId: string; threadId?: string }): string {
  return `guild:${input.guildId}:channel:${input.channelId}${input.threadId ? `:thread:${input.threadId}` : ""}`;
}

export class ConversationStateStore {
  private readonly states = new Map<string, ConversationRuntimeState>();

  get(id: string): ConversationRuntimeState {
    const existing = this.states.get(id);
    if (existing) return existing;
    const created: ConversationRuntimeState = {
      engagement: "not_engaged",
      recentBotMessageIds: [],
      consecutiveBotReplies: 0,
      humanMessagesSinceLastBot: 0,
      unrelatedHumanMessagesSinceLastBot: 0,
      ambientReplyTimes: [],
    };
    this.states.set(id, created);
    return created;
  }

  set(id: string, state: ConversationRuntimeState): void {
    this.states.set(id, state);
  }
}
