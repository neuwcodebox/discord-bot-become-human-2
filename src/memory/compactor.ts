import { join } from "node:path";
import { truncateText } from "../context/limits.js";
import { buildTranscript } from "../conversation/transcript-builder.js";
import { appendJsonl, readCursor, readJsonl, writeCursor } from "../storage/jsonl.js";
import type { AgentContextMessage, AppConfig, HistoryEntry, NormalizedDiscordEvent } from "../types.js";

export type EventSummaryGenerator = (events: NormalizedDiscordEvent[]) => Promise<string>;

export class MemoryCompactor {
  constructor(
    private readonly workspaceRoot: string,
    private readonly config: AppConfig,
    private readonly summarize: EventSummaryGenerator = async (events) => fallbackSummary(events),
  ) {}

  async compactIfNeeded(): Promise<HistoryEntry | undefined> {
    if (!this.config.memory.compaction.enabled) return undefined;
    const eventsPath = join(this.workspaceRoot, "memory", "events.jsonl");
    const historyPath = join(this.workspaceRoot, "memory", "history.jsonl");
    const cursorPath = join(this.workspaceRoot, "memory", ".cursor");
    const all = await readJsonl<NormalizedDiscordEvent>(eventsPath);
    const lastCompacted = await readCursor(cursorPath);
    const pending = all.filter((event) => (event.cursor ?? 0) > lastCompacted);

    if (pending.length < this.config.memory.compaction.maxEventsBeforeCompaction) return undefined;
    const min = this.config.memory.compaction.minEventsPerSummary;
    const slice = pending.slice(
      0,
      Math.max(min, pending.length - this.config.conversation.maxRecentMessages),
    );
    if (slice.length < min) return undefined;

    const cursors = slice.map((event) => event.cursor ?? 0).filter((cursor) => cursor > 0);
    const participants = [...new Set(slice.flatMap((event) => humanAuthorId(event) ?? []))];
    const history = await readJsonl<HistoryEntry>(historyPath);
    const channelIds = [...new Set(slice.map((event) => event.channelId))];
    const threadIds = [
      ...new Set(
        slice.map((event) => event.threadId).filter((threadId): threadId is string => Boolean(threadId)),
      ),
    ];
    const entry: HistoryEntry = {
      cursor: history.length + 1,
      time: new Date().toISOString(),
      fromEventCursor: Math.min(...cursors),
      toEventCursor: Math.max(...cursors),
      ...(slice[0]?.guildId ? { guildId: slice[0].guildId } : {}),
      channelIds,
      ...(threadIds.length > 0 ? { threadIds } : {}),
      participants,
      summary: truncateText(await this.summarizeSafely(slice), this.config.context.maxArchiveSummaryChars)
        .text,
      memoryTargets: ["memory/MEMORY.md", ...participants.map((id) => `users/${id}/USER.md`)],
    };
    await appendJsonl(historyPath, entry);
    await writeCursor(cursorPath, entry.toEventCursor);
    return entry;
  }

  private async summarizeSafely(events: NormalizedDiscordEvent[]): Promise<string> {
    try {
      const summary = await this.summarize(events);
      return summary.trim().length > 0 ? summary : fallbackSummary(events);
    } catch {
      return fallbackSummary(events);
    }
  }
}

export function buildCompactionSummaryContext(
  events: NormalizedDiscordEvent[],
  timezone: string,
  botUserId: string,
): AgentContextMessage[] {
  const first = events[0];
  const transcript = first
    ? buildTranscript(events, {
        guildId: first.guildId,
        channelId: first.channelId,
        timezone,
        botUserId,
      })
    : "";
  return [
    {
      role: "system",
      content:
        "Summarize older Discord conversation events for long-term archive. Return only a concise factual summary. Preserve stable facts, decisions, unresolved questions, and user preferences. Do not invent facts.",
    },
    {
      role: "user",
      content: `Archive this older conversation prefix. It will be removed from the live recent transcript but stored in memory/history.jsonl.\n\n${transcript}`,
    },
  ];
}

function humanAuthorId(event: NormalizedDiscordEvent): string | undefined {
  if (event.type !== "message_create" && event.type !== "message_update") return event.authorId;
  if (event.payload.author.isBot) return undefined;
  return event.authorId;
}

function fallbackSummary(events: NormalizedDiscordEvent[]): string {
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
    .slice(0, 12)
    .join(" / ");
  return `[RAW] ${events.length} events. Participants: ${participants || "unknown"}. Recent visible topics: ${topics || "non-message Discord events"}.`;
}
