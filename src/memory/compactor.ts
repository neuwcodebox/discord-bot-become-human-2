import { join } from "node:path";
import { appendJsonl, readCursor, readJsonl, writeCursor } from "../storage/jsonl.js";
import type { AppConfig, HistoryEntry, NormalizedDiscordEvent } from "../types.js";

export class MemoryCompactor {
  constructor(
    private readonly workspaceRoot: string,
    private readonly config: AppConfig,
  ) {}

  async compactIfNeeded(): Promise<HistoryEntry | undefined> {
    if (!this.config.memory.compaction.enabled) return undefined;
    const eventsPath = join(this.workspaceRoot, "memory", "events.jsonl");
    const historyPath = join(this.workspaceRoot, "memory", "history.jsonl");
    const cursorPath = join(this.workspaceRoot, "memory", ".cursor");
    const historyCursorPath = join(this.workspaceRoot, "memory", ".history_cursor");
    const all = await readJsonl<NormalizedDiscordEvent>(eventsPath);
    const lastCompacted = await readCursor(historyCursorPath);
    const pending = all.filter((event) => (event.cursor ?? 0) > lastCompacted);

    if (pending.length < this.config.memory.compaction.maxEventsBeforeCompaction) return undefined;
    const min = this.config.memory.compaction.minEventsPerSummary;
    const slice = pending.slice(
      0,
      Math.max(min, pending.length - this.config.conversation.maxRecentMessages),
    );
    if (slice.length < min) return undefined;

    const cursors = slice.map((event) => event.cursor ?? 0).filter((cursor) => cursor > 0);
    const participants = [
      ...new Set(slice.map((event) => event.authorId).filter((id): id is string => Boolean(id))),
    ];
    const history = await readJsonl<HistoryEntry>(historyPath);
    const entry: HistoryEntry = {
      cursor: history.length + 1,
      time: new Date().toISOString(),
      fromEventCursor: Math.min(...cursors),
      toEventCursor: Math.max(...cursors),
      participants,
      summary: summarizeEvents(slice),
      memoryTargets: ["memory/MEMORY.md", ...participants.map((id) => `users/${id}/USER.md`)],
    };
    await appendJsonl(historyPath, entry);
    await writeCursor(historyCursorPath, entry.toEventCursor);
    await writeCursor(cursorPath, Math.max(await readCursor(cursorPath), entry.toEventCursor));
    return entry;
  }
}

function summarizeEvents(events: NormalizedDiscordEvent[]): string {
  const messages = events
    .filter(
      (event): event is Extract<NormalizedDiscordEvent, { type: "message_create" | "message_update" }> =>
        event.type === "message_create" || event.type === "message_update",
    )
    .map((event) => event.payload);
  const participants = [...new Set(messages.map((message) => message.author.displayName))].join(", ");
  const topics = messages
    .map((message) => message.cleanContent.trim())
    .filter(Boolean)
    .slice(0, 8)
    .join(" / ");
  return `Participants: ${participants || "unknown"}. Recent visible topics: ${topics || "non-message Discord events"}.`;
}
