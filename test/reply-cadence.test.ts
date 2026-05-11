import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config.js";
import { checkReplyHardGates } from "../src/conversation/reply-cadence.js";
import type { ConversationRuntimeState, NormalizedDiscordMessage } from "../src/types.js";

describe("reply cadence gates", () => {
  it("keeps the long unprompted gate available for true unprompted replies", () => {
    const state = stateAfterBotReply(30);
    const result = checkReplyHardGates(defaultConfig, state, message("m1", "hello"), {
      unprompted: true,
    });

    expect(result).toEqual({ allowed: false, reason: "minSecondsBetweenUnpromptedReplies gate" });
  });

  it("allows engaged human follow-up messages after the short reply interval", () => {
    const state = stateAfterBotReply(30);
    const result = checkReplyHardGates(defaultConfig, state, message("m1", "follow up"), {
      unprompted: false,
    });

    expect(result).toEqual({ allowed: true });
  });

  it("can allow engaged follow-up messages during cooldown so stay decision can decide", () => {
    const state = stateAfterBotReply(6);
    state.cooldownUntil = new Date(Date.now() + 20_000).toISOString();

    const result = checkReplyHardGates(defaultConfig, state, message("m1", "say more"), {
      unprompted: false,
      allowDuringCooldown: true,
      allowBeforeMinReplyInterval: true,
    });

    expect(result).toEqual({ allowed: true });
  });

  it("still blocks true unprompted replies during cooldown", () => {
    const state = stateAfterBotReply(6);
    state.cooldownUntil = new Date(Date.now() + 20_000).toISOString();

    const result = checkReplyHardGates(defaultConfig, state, message("m1", "background"), {
      unprompted: true,
    });

    expect(result).toEqual({ allowed: false, reason: "cooldownUntil is active" });
  });

  it("recognizes explicit bot mentions when checking consecutive reply gates", () => {
    const state = stateAfterBotReply(120);
    state.consecutiveBotReplies = defaultConfig.conversation.engaged.maxConsecutiveBotReplies;

    const result = checkReplyHardGates(defaultConfig, state, message("m1", "<@bot-1>", ["bot-1"]), {
      unprompted: false,
      botUserId: "bot-1",
      botNames: ["bot"],
    });

    expect(result).toEqual({ allowed: true });
  });
});

function stateAfterBotReply(secondsAgo: number): ConversationRuntimeState {
  return {
    engagement: "engaged",
    lastBotMessageAt: new Date(Date.now() - secondsAgo * 1000).toISOString(),
    lastHumanMessageAt: new Date().toISOString(),
    recentBotMessageIds: ["bot-message"],
    consecutiveBotReplies: 0,
    humanMessagesSinceLastBot: 1,
    unrelatedHumanMessagesSinceLastBot: 0,
    ambientReplyTimes: [],
  };
}

function message(id: string, cleanContent: string, mentionIds: string[] = []): NormalizedDiscordMessage {
  return {
    id,
    guildId: "g",
    channelId: "c",
    author: { id: "u1", username: "u1", displayName: "User", isBot: false },
    content: cleanContent,
    cleanContent,
    createdAt: new Date().toISOString(),
    mentions: mentionIds.map((mentionId) => ({ id: mentionId, displayName: mentionId })),
    attachments: [],
    embeds: [],
    reactions: [],
    links: [],
  };
}
