import { describe, expect, it } from "vitest";
import { ConversationStateStore, conversationId } from "../src/conversation/state-store.js";

describe("conversation state", () => {
  it("isolates conversations by guild, channel, and thread", () => {
    const store = new ConversationStateStore();
    const key = { guildId: "g1", channelId: "c1" };
    store.get(conversationId(key)).engagement = "engaged";

    expect(store.get(conversationId(key)).engagement).toBe("engaged");
    for (const other of [
      { ...key, guildId: "g2" },
      { ...key, channelId: "c2" },
      { ...key, threadId: "t1" },
    ]) {
      expect(store.get(conversationId(other)).engagement).toBe("not_engaged");
    }
  });

  it("finishes a conversation's current task before running the next", async () => {
    const store = new ConversationStateStore();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const completed: string[] = [];
    const fail = (error: unknown) => {
      throw error;
    };
    const first = store.enqueue(
      "conversation",
      async () => {
        started.resolve();
        await release.promise;
        completed.push("first");
      },
      fail,
    );
    const second = store.enqueue(
      "conversation",
      async () => {
        completed.push("second");
      },
      fail,
    );

    await started.promise;
    expect(completed).toEqual([]);
    release.resolve();
    await Promise.all([first, second]);
    expect(completed).toEqual(["first", "second"]);
  });

  it("allows another conversation to progress while one is busy", async () => {
    const store = new ConversationStateStore();
    const release = Promise.withResolvers<void>();
    const fail = (error: unknown) => {
      throw error;
    };
    const busy = store.enqueue("busy", () => release.promise, fail);
    let completed = false;

    try {
      await store.enqueue(
        "other",
        async () => {
          completed = true;
        },
        fail,
      );
      expect(completed).toBe(true);
    } finally {
      release.resolve();
      await busy;
    }
  });

  it("processes subsequent messages after reporting a failed task", async () => {
    const store = new ConversationStateStore();
    const errors: unknown[] = [];
    const failure = new Error("failed task");
    const report = (error: unknown) => {
      errors.push(error);
    };
    const failed = store.enqueue(
      "conversation",
      async () => {
        throw failure;
      },
      report,
    );
    let completed = false;
    const next = store.enqueue(
      "conversation",
      async () => {
        completed = true;
      },
      report,
    );

    await Promise.all([failed, next]);
    expect(errors).toEqual([failure]);
    expect(completed).toBe(true);
  });
});
