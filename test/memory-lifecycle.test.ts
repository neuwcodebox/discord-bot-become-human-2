import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentUnavailableError } from "../src/agent/availability.js";
import { defaultConfig } from "../src/config.js";
import { MemoryCompactor } from "../src/memory/compactor.js";
import { EventLog } from "../src/memory/event-log.js";
import { readJsonl } from "../src/storage/jsonl.js";
import type { HistoryEntry, NormalizedDiscordEvent } from "../src/types.js";
import { createTestWorkspace } from "./helpers/workspace.js";

describe("memory lifecycle", () => {
  it("preserves pending events and cursors when the subscription gate pauses compaction", async () => {
    const { root, log, config } = await createMemoryFixture();
    await appendConversation(log);
    await expect(
      new MemoryCompactor(root, config, async () => {
        throw new AgentUnavailableError();
      }).compactIfNeeded(),
    ).rejects.toBeInstanceOf(AgentUnavailableError);
    await expect(readFile(join(root, "memory", ".cursor"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readJsonl<HistoryEntry>(join(root, "memory", "history.jsonl"))).resolves.toEqual([]);
    const recovered = await new MemoryCompactor(root, config, async () => "recovered").compactIfNeeded();
    expect(recovered?.fromEventCursor).toBe(1);
    expect(recovered?.summary).toBe("recovered");
  });

  it("allocates distinct ordered cursors for concurrent appends from separate EventLog instances", async () => {
    const root = await createTestWorkspace("dbh2-stream-log-");
    const saved = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        new EventLog(root).append(messageEvent(`m${index}`, "u1", `message ${index}`)),
      ),
    );
    expect(saved.map((event) => event.cursor)).toEqual(Array.from({ length: 12 }, (_, index) => index + 1));
    expect(await new EventLog(root).readAll()).toHaveLength(12);
  });

  it("uses .cursor as compaction cursor, not event id allocation", async () => {
    const { root, log, config } = await createMemoryFixture();
    await appendConversation(log);

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
    const { root, log, config } = await createMemoryFixture();
    await appendConversation(log, [
      messageEvent("m1", "human-1", "hello"),
      messageEvent("m2", "bot-1", "bot reply", true),
      messageEvent("m3", "human-2", "next"),
    ]);

    const entry = await new MemoryCompactor(root, config).compactIfNeeded();

    expect(entry?.participants).toEqual(["human-1"]);
    expect(entry?.memoryTargets).toContain("users/human-1/USER.md");
    expect(entry?.memoryTargets).not.toContain("users/bot-1/USER.md");
  });

  it("uses an injected summary generator for compacted archive entries", async () => {
    const { root, log, config } = await createMemoryFixture();
    await appendConversation(log);

    const entry = await new MemoryCompactor(
      root,
      config,
      async () => "LLM archive summary",
    ).compactIfNeeded();

    expect(entry?.summary).toBe("LLM archive summary");
    expect(entry?.channelIds).toEqual(["c"]);
  });

  it("falls back to raw archive summary when compaction summarization fails", async () => {
    const { root, log, config } = await createMemoryFixture();
    await appendConversation(log);

    const entry = await new MemoryCompactor(root, config, async () => {
      throw new Error("LLM unavailable");
    }).compactIfNeeded();

    expect(entry?.summary).toContain("[RAW] 2 events");
    await expect(readFile(join(root, "memory", ".cursor"), "utf8")).resolves.toBe("2\n");
  });
});

async function createMemoryFixture() {
  const root = await createTestWorkspace("dbh2-memory-");
  return {
    root,
    log: new EventLog(root),
    config: {
      ...defaultConfig,
      memory: {
        ...defaultConfig.memory,
        compaction: { enabled: true, maxEventsBeforeCompaction: 3, minEventsPerSummary: 2 },
      },
      conversation: { ...defaultConfig.conversation, maxRecentMessages: 1 },
    },
  };
}

async function appendConversation(
  log: EventLog,
  events = [
    messageEvent("m1", "u1", "first"),
    messageEvent("m2", "u2", "second"),
    messageEvent("m3", "u1", "third"),
  ],
): Promise<void> {
  for (const event of events) await log.append(event);
}

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
