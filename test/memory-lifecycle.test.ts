import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config.js";
import { MemoryCompactor } from "../src/memory/compactor.js";
import { EventLog } from "../src/memory/event-log.js";
import { readJsonl } from "../src/storage/jsonl.js";
import type { HistoryEntry, NormalizedDiscordEvent } from "../src/types.js";

describe("memory lifecycle", () => {
  it("uses .cursor as compaction cursor, not event id allocation", async () => {
    const root = await mkdtemp(join(tmpdir(), "dbh2-memory-"));
    const log = new EventLog(root);
    const config = {
      ...defaultConfig,
      memory: {
        ...defaultConfig.memory,
        compaction: { enabled: true, maxEventsBeforeCompaction: 3, minEventsPerSummary: 2 },
      },
      conversation: { ...defaultConfig.conversation, maxRecentMessages: 1 },
    };

    await log.append(messageEvent("m1", "u1", "first"));
    await log.append(messageEvent("m2", "u2", "second"));
    await log.append(messageEvent("m3", "u1", "third"));

    await expect(readFile(join(root, "memory", ".cursor"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const entry = await new MemoryCompactor(root, config).compactIfNeeded();

    expect(entry?.fromEventCursor).toBe(1);
    expect(entry?.toEventCursor).toBe(2);
    await expect(readFile(join(root, "memory", ".cursor"), "utf8")).resolves.toBe("2\n");
    await expect(readJsonl<HistoryEntry>(join(root, "memory", "history.jsonl"))).resolves.toHaveLength(1);

    const appended = await log.append(messageEvent("m4", "u3", "fourth"));
    expect(appended.cursor).toBe(4);
  });

  it("does not target bot-authored USER.md files during compaction", async () => {
    const root = await mkdtemp(join(tmpdir(), "dbh2-memory-"));
    const log = new EventLog(root);
    const config = {
      ...defaultConfig,
      memory: {
        ...defaultConfig.memory,
        compaction: { enabled: true, maxEventsBeforeCompaction: 3, minEventsPerSummary: 2 },
      },
      conversation: { ...defaultConfig.conversation, maxRecentMessages: 1 },
    };

    await log.append(messageEvent("m1", "human-1", "hello"));
    await log.append(messageEvent("m2", "bot-1", "bot reply", true));
    await log.append(messageEvent("m3", "human-2", "next"));

    const entry = await new MemoryCompactor(root, config).compactIfNeeded();

    expect(entry?.participants).toEqual(["human-1"]);
    expect(entry?.memoryTargets).toContain("users/human-1/USER.md");
    expect(entry?.memoryTargets).not.toContain("users/bot-1/USER.md");
  });

  it("uses an injected summary generator for compacted archive entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "dbh2-memory-"));
    const log = new EventLog(root);
    const config = {
      ...defaultConfig,
      memory: {
        ...defaultConfig.memory,
        compaction: { enabled: true, maxEventsBeforeCompaction: 3, minEventsPerSummary: 2 },
      },
      conversation: { ...defaultConfig.conversation, maxRecentMessages: 1 },
    };

    await log.append(messageEvent("m1", "u1", "first"));
    await log.append(messageEvent("m2", "u2", "second"));
    await log.append(messageEvent("m3", "u1", "third"));

    const entry = await new MemoryCompactor(root, config, async (events) => {
      expect(events).toHaveLength(2);
      return "LLM archive summary";
    }).compactIfNeeded();

    expect(entry?.summary).toBe("LLM archive summary");
    expect(entry?.channelIds).toEqual(["c"]);
  });

  it("falls back to raw archive summary when compaction summarization fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "dbh2-memory-"));
    const log = new EventLog(root);
    const config = {
      ...defaultConfig,
      memory: {
        ...defaultConfig.memory,
        compaction: { enabled: true, maxEventsBeforeCompaction: 3, minEventsPerSummary: 2 },
      },
      conversation: { ...defaultConfig.conversation, maxRecentMessages: 1 },
    };

    await log.append(messageEvent("m1", "u1", "first"));
    await log.append(messageEvent("m2", "u2", "second"));
    await log.append(messageEvent("m3", "u1", "third"));

    const entry = await new MemoryCompactor(root, config, async () => {
      throw new Error("LLM unavailable");
    }).compactIfNeeded();

    expect(entry?.summary).toContain("[RAW] 2 events");
    await expect(readFile(join(root, "memory", ".cursor"), "utf8")).resolves.toBe("2\n");
  });
});

function messageEvent(
  messageId: string,
  authorId: string,
  content: string,
  isBot = false,
): NormalizedDiscordEvent {
  return {
    type: "message_create",
    time: "2026-05-10T12:00:00.000Z",
    guildId: "g",
    channelId: "c",
    messageId,
    authorId,
    payload: {
      id: messageId,
      guildId: "g",
      channelId: "c",
      author: { id: authorId, username: authorId, displayName: authorId, isBot },
      content,
      cleanContent: content,
      createdAt: "2026-05-10T12:00:00.000Z",
      mentions: [],
      attachments: [],
      embeds: [],
      reactions: [],
      links: [],
    },
  };
}
