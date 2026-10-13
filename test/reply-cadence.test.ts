import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../src/config.js";
import { checkReplyHardGates } from "../src/conversation/reply-cadence.js";
import type { ConversationRuntimeState } from "../src/types.js";
import { createMessage } from "./helpers/conversation.js";

const now = new Date("2026-05-11T12:00:00.000Z");

describe("reply cadence gates", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });
  afterEach(() => vi.useRealTimers());

  it.each([
    { unprompted: true, allowed: false },
    { unprompted: false, allowed: true },
  ])(
    "allows=$allowed for an unprompted=$unprompted reply after the short interval",
    ({ unprompted, allowed }) => {
      const result = checkReplyHardGates(defaultConfig, stateAfterBotReply(30), createMessage(), {
        unprompted,
      });

      expect(result.allowed).toBe(allowed);
    },
  );

  it.each([
    { unprompted: false, bypassCooldown: true, allowed: true },
    { unprompted: true, bypassCooldown: false, allowed: false },
  ])(
    "allows=$allowed during cooldown for an unprompted=$unprompted reply",
    ({ unprompted, bypassCooldown, allowed }) => {
      const state = stateAfterBotReply(6);
      state.cooldownUntil = new Date(now.getTime() + 20_000).toISOString();

      const result = checkReplyHardGates(defaultConfig, state, createMessage(), {
        unprompted,
        allowDuringCooldown: bypassCooldown,
        allowBeforeMinReplyInterval: bypassCooldown,
      });

      expect(result.allowed).toBe(allowed);
    },
  );

  it("allows an explicit bot mention after the consecutive reply limit", () => {
    const state = stateAfterBotReply(120);
    state.consecutiveBotReplies = defaultConfig.conversation.engaged.maxConsecutiveBotReplies;

    const result = checkReplyHardGates(
      defaultConfig,
      state,
      createMessage("m1", {
        content: "<@bot-1>",
        cleanContent: "<@bot-1>",
        mentions: [{ id: "bot-1", displayName: "bot" }],
      }),
      {
        unprompted: false,
        botUserId: "bot-1",
        botNames: ["bot"],
      },
    );

    expect(result.allowed).toBe(true);
  });
});

function stateAfterBotReply(secondsAgo: number): ConversationRuntimeState {
  return {
    engagement: "engaged",
    lastBotMessageAt: new Date(now.getTime() - secondsAgo * 1000).toISOString(),
    lastHumanMessageAt: now.toISOString(),
    recentBotMessageIds: ["bot-message"],
    consecutiveBotReplies: 0,
    humanMessagesSinceLastBot: 1,
    unrelatedHumanMessagesSinceLastBot: 0,
    ambientReplyTimes: [],
  };
}
