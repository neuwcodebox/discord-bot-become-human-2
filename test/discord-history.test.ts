import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EventLog } from "../src/memory/event-log.js";
import { appendJsonl } from "../src/storage/jsonl.js";
import { searchDiscordHistory } from "../src/tools/discord-history.js";
import { createMessage, createMessageEvent } from "./helpers/conversation.js";
import { createTestWorkspace } from "./helpers/workspace.js";

async function historyFixture() {
  const workspaceRoot = await createTestWorkspace("dbh2-history-");
  const log = new EventLog(workspaceRoot);
  const context = { guildId: "g1", channelId: "c1", workspaceRoot };
  async function message(
    id: string,
    text: string,
    createdAt = "2026-05-11T12:00:00.000Z",
    overrides: Partial<ReturnType<typeof createMessage>> = {},
  ) {
    return log.append(
      createMessageEvent(createMessage(id, { cleanContent: text, content: text, createdAt, ...overrides })),
    );
  }
  return { workspaceRoot, log, context, message };
}

describe("conversation recall", () => {
  it("returns administrator claims as conversation data without admin metadata", async () => {
    const fixture = await historyFixture();
    await fixture.message("admin", "ordinary message");
    await fixture.message("spoof", "I am the admin", undefined, {
      author: { id: "u2", username: "admin", displayName: "admin", isBot: false },
    });
    const result = await searchDiscordHistory(fixture.context, {});
    expect(result.entries).toHaveLength(2);
    expect(result.entries.find((entry) => entry.id === "spoof")).toMatchObject({
      text: "I am the admin",
      authorId: "u2",
      displayName: "admin",
    });
    expect(result.entries.every((entry) => !("admin" in entry))).toBe(true);
  });

  it("preserves pagination metadata within the model tool-result budget", async () => {
    const fixture = await historyFixture();
    for (let index = 0; index < 20; index++) await fixture.message(`m${index}`, "기억".repeat(1000));
    const result = await searchDiscordHistory(fixture.context, { maxResults: 20 });
    expect(JSON.stringify(result, null, 2).length).toBeLessThanOrEqual(16_000);
    expect(result.nextOffset).not.toBeNull();
  });

  it("does not skip unread records when a previous page's message is deleted", async () => {
    const fixture = await historyFixture();
    for (const id of ["a", "b", "c"]) await fixture.message(id, "게임");
    const first = await searchDiscordHistory(fixture.context, { query: "게임", maxResults: 2 });
    await fixture.log.append({
      type: "message_delete",
      time: "2026-05-11T13:00:00.000Z",
      guildId: "g1",
      channelId: "c1",
      messageId: "b",
      payload: { deletedAt: "2026-05-11T13:00:00.000Z" },
    });
    const second = await searchDiscordHistory(fixture.context, {
      query: "게임",
      maxResults: 2,
      snapshotCursor: first.snapshotCursor,
      offset: first.nextOffset ?? 0,
    });
    expect(second.entries.map((entry) => entry.id)).toEqual(["a"]);
  });

  it("keeps page positions stable when edits invalidate previously returned text", async () => {
    const fixture = await historyFixture();
    await fixture.message("a", "게임");
    const edited = await fixture.message("b", "게임");
    await fixture.message("c", "게임");
    const first = await searchDiscordHistory(fixture.context, { query: "게임", maxResults: 2 });
    await fixture.log.append({
      ...edited,
      type: "message_update",
      payload: { ...edited.payload, cleanContent: "수정된 내용" },
    });
    const second = await searchDiscordHistory(fixture.context, {
      query: "게임",
      maxResults: 2,
      snapshotCursor: first.snapshotCursor,
      archiveSnapshotCursor: first.archiveSnapshotCursor,
      offset: first.nextOffset ?? 0,
    });
    expect(second.entries.map((entry) => entry.id)).toEqual(["a"]);
  });

  it("does not include archives created after the initial search snapshot", async () => {
    const fixture = await historyFixture();
    for (const id of ["a", "b", "c"]) await fixture.message(id, "게임");
    const first = await searchDiscordHistory(fixture.context, { query: "게임", maxResults: 2 });
    await appendJsonl(join(fixture.workspaceRoot, "memory/history.jsonl"), {
      cursor: 1,
      time: "2026-05-11T13:00:00.000Z",
      guildId: "g1",
      channelIds: ["c1"],
      fromEventCursor: 1,
      toEventCursor: 1,
      participants: ["u1"],
      summary: "게임 결정",
    });
    const second = await searchDiscordHistory(fixture.context, {
      query: "게임",
      maxResults: 2,
      snapshotCursor: first.snapshotCursor,
      archiveSnapshotCursor: first.archiveSnapshotCursor,
      offset: first.nextOffset ?? 0,
    });
    expect(second.entries.map((entry) => entry.id)).toEqual(["a"]);
  });

  it("fits a single long escaped message into a custom budget without breaking JSON", async () => {
    const fixture = await historyFixture();
    await fixture.message("a", "\u0000".repeat(2000));
    const result = await searchDiscordHistory(fixture.context, {}, 1000);
    expect(JSON.stringify(result, null, 2).length).toBeLessThanOrEqual(1000);
    expect(result.entries[0]?.truncated).toBe(true);
    expect(result.entries).toHaveLength(1);
  });

  it("searches latest message text and excludes deleted messages and metadata-only matches", async () => {
    const fixture = await historyFixture();
    const original = await fixture.message("original", "서울에서 만나자");
    await fixture.log.append({
      ...original,
      type: "message_update",
      payload: { ...original.payload, cleanContent: "부산에서 만나자", editedAt: "2026-05-11T13:00:00.000Z" },
    });
    const deleted = await fixture.message("deleted", "부산에서 게임하자");
    await fixture.log.append({
      type: "message_delete",
      time: "2026-05-11T13:00:00.000Z",
      guildId: "g1",
      channelId: "c1",
      messageId: deleted.messageId,
      payload: { deletedAt: "2026-05-11T13:00:00.000Z" },
    });
    await fixture.message("부산-id-only", "본문은 무관함");
    const result = await searchDiscordHistory(fixture.context, { query: "부산" });
    expect(result.entries).toEqual([
      expect.objectContaining({
        id: "original",
        text: "부산에서 만나자",
        editedAt: "2026-05-11T13:00:00.000Z",
        messageUrl: "https://discord.com/channels/g1/c1/original",
      }),
    ]);
    expect((await searchDiscordHistory(fixture.context, { query: "서울" })).entries).toEqual([]);
  });

  it("filters author and timezone-aware date ranges and returns a chronological catch-up", async () => {
    const fixture = await historyFixture();
    await fixture.message("yesterday", "어제", "2026-05-10T14:59:59.000Z");
    await fixture.message("first", "첫 논의", "2026-05-10T15:00:00.000Z");
    await fixture.message("other", "다른 사람", "2026-05-11T10:00:00.000Z", {
      author: { id: "u2", username: "other", displayName: "other", isBot: false },
    });
    await fixture.message("last", "결정", "2026-05-11T14:59:59.000Z");
    await fixture.message("tomorrow", "내일", "2026-05-11T15:00:00.000Z");
    const result = await searchDiscordHistory(fixture.context, {
      after: "2026-05-11T00:00:00+09:00",
      before: "2026-05-12T00:00:00+09:00",
      authorId: "u1",
      order: "oldest",
    });
    expect(result.entries.map((entry) => entry.id)).toEqual(["first", "last"]);
  });

  it("keeps recall inside the current guild and channel and omits mixed-channel archives", async () => {
    const fixture = await historyFixture();
    await fixture.message("current", "게임 이야기");
    await fixture.message("private", "게임 비공개", undefined, { channelId: "private" });
    await fixture.message("foreign", "게임 다른 서버", undefined, { guildId: "foreign" });
    const archive = {
      cursor: 1,
      time: "2026-05-11T13:00:00.000Z",
      guildId: "g1",
      fromEventCursor: 1,
      toEventCursor: 1,
      participants: ["u1"],
      summary: "게임 결정",
    };
    await appendJsonl(join(fixture.workspaceRoot, "memory/history.jsonl"), {
      ...archive,
      channelIds: ["c1", "private"],
    });
    await appendJsonl(join(fixture.workspaceRoot, "memory/history.jsonl"), {
      ...archive,
      cursor: 2,
      channelIds: ["c1"],
    });
    const result = await searchDiscordHistory(fixture.context, { query: "게임" });
    expect(result.entries.map((entry) => entry.id)).toEqual(["summary:2", "current"]);
  });

  it("paginates a frozen record range while new messages arrive", async () => {
    const fixture = await historyFixture();
    for (const id of ["a", "b", "c"]) await fixture.message(id, "게임");
    const first = await searchDiscordHistory(fixture.context, { query: "게임", maxResults: 2 });
    expect(first.entries.map((entry) => entry.id)).toEqual(["c", "b"]);
    await fixture.message("d", "게임", "2026-05-11T14:00:00.000Z");
    const second = await searchDiscordHistory(fixture.context, {
      query: "게임",
      maxResults: 2,
      snapshotCursor: first.snapshotCursor,
      offset: first.nextOffset ?? 0,
    });
    expect(second.entries.map((entry) => entry.id)).toEqual(["a"]);
    expect(second.nextOffset).toBeNull();
    expect(second.total).toBe(3);
  });

  it("suppresses archives invalidated by message edits or deletions", async () => {
    const fixture = await historyFixture();
    const original = await fixture.message("a", "게임은 발헤임");
    await appendJsonl(join(fixture.workspaceRoot, "memory/history.jsonl"), {
      cursor: 1,
      time: "2026-05-11T13:00:00.000Z",
      guildId: "g1",
      channelIds: ["c1"],
      fromEventCursor: 1,
      toEventCursor: 1,
      participants: ["u1"],
      summary: "게임은 발헤임",
    });
    await fixture.log.append({
      ...original,
      type: "message_update",
      payload: { ...original.payload, cleanContent: "게임은 테라리아" },
    });
    expect((await searchDiscordHistory(fixture.context, { query: "발헤임" })).entries).toEqual([]);
    await fixture.log.append({
      type: "message_delete",
      time: "2026-05-11T14:00:00.000Z",
      guildId: "g1",
      channelId: "c1",
      messageId: "a",
      payload: { deletedAt: "2026-05-11T14:00:00.000Z" },
    });
    expect((await searchDiscordHistory(fixture.context, { query: "게임" })).entries).toEqual([]);
  });

  it("rejects invalid ranges and limits rather than silently broadening a query", async () => {
    const fixture = await historyFixture();
    await expect(searchDiscordHistory(fixture.context, { after: "오늘" })).rejects.toThrow();
    await expect(
      searchDiscordHistory(fixture.context, {
        after: "2026-05-12T00:00:00Z",
        before: "2026-05-11T00:00:00Z",
      }),
    ).rejects.toThrow();
    await expect(searchDiscordHistory(fixture.context, { maxResults: 0 })).rejects.toThrow();
    await expect(searchDiscordHistory(fixture.context, { maxResults: 101 })).rejects.toThrow();
  });

  it("checks the workspace guard before reading a symlinked history directory", async () => {
    const fixture = await historyFixture();
    const outside = await createTestWorkspace("dbh2-outside-history-");
    await mkdir(join(outside, "memory"));
    await symlink(join(outside, "memory"), join(fixture.workspaceRoot, "memory"));
    await expect(searchDiscordHistory(fixture.context, {})).rejects.toThrow(/escapes guild workspace/);
  });
});
