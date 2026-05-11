import { describe, expect, it } from "vitest";
import {
  appendFollowUpMessage,
  computeFollowUpFlushDelayMs,
  shouldFlushByMessageCount,
} from "../src/conversation/follow-up-batch.js";

const config = {
  quietDebounceMs: [3000, 5000],
  directTriggerDebounceMs: [1000, 2000],
  maxWaitMs: 15000,
  maxMessages: 3,
} as const;

describe("follow-up batching", () => {
  it("accumulates message ids and remembers whether any message was directed at the bot", () => {
    const first = appendFollowUpMessage({
      messageId: "m1",
      relatedToBot: false,
      now: new Date("2026-05-11T12:00:00.000Z"),
    });
    const second = appendFollowUpMessage({
      batch: first,
      messageId: "m2",
      relatedToBot: true,
      now: new Date("2026-05-11T12:00:02.000Z"),
    });

    expect(second.messageIds).toEqual(["m1", "m2"]);
    expect(second.since).toBe("2026-05-11T12:00:00.000Z");
    expect(second.lastMessageAt).toBe("2026-05-11T12:00:02.000Z");
    expect(second.relatedToBot).toBe(true);
  });

  it("flushes when the batch reaches the configured message count", () => {
    const batch = {
      since: "2026-05-11T12:00:00.000Z",
      lastMessageAt: "2026-05-11T12:00:03.000Z",
      messageIds: ["m1", "m2", "m3"],
      relatedToBot: false,
    };

    expect(shouldFlushByMessageCount(batch, config)).toBe(true);
  });

  it("caps quiet debounce by max wait so active chats cannot postpone forever", () => {
    const batch = {
      since: "2026-05-11T12:00:00.000Z",
      lastMessageAt: "2026-05-11T12:00:12.000Z",
      messageIds: ["m1", "m2"],
      relatedToBot: false,
    };

    const delay = computeFollowUpFlushDelayMs({
      batch,
      config,
      state: {},
      nowMs: Date.parse("2026-05-11T12:00:12.000Z"),
      debounceMs: 5000,
    });

    expect(delay).toBe(3000);
  });

  it("uses cooldown as an earliest flush time for non-directed batches", () => {
    const batch = {
      since: "2026-05-11T12:00:00.000Z",
      lastMessageAt: "2026-05-11T12:00:01.000Z",
      messageIds: ["m1"],
      relatedToBot: false,
    };

    const delay = computeFollowUpFlushDelayMs({
      batch,
      config,
      state: { cooldownUntil: "2026-05-11T12:00:08.000Z" },
      nowMs: Date.parse("2026-05-11T12:00:01.000Z"),
      debounceMs: 3000,
    });

    expect(delay).toBe(7000);
  });

  it("does not let cooldown delay a directed batch", () => {
    const batch = {
      since: "2026-05-11T12:00:00.000Z",
      lastMessageAt: "2026-05-11T12:00:01.000Z",
      messageIds: ["m1"],
      relatedToBot: true,
    };

    const delay = computeFollowUpFlushDelayMs({
      batch,
      config,
      state: { cooldownUntil: "2026-05-11T12:00:08.000Z" },
      nowMs: Date.parse("2026-05-11T12:00:01.000Z"),
      debounceMs: 1000,
    });

    expect(delay).toBe(1000);
  });
});
