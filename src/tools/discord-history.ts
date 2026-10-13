import { z } from "zod";
import { truncateText } from "../context/limits.js";
import { assertInsideWorkspace } from "../paths/workspace-guard.js";
import { readJsonl } from "../storage/jsonl.js";
import type { ToolContext } from "../types.js";

export const historyQuerySchema = z
  .object({
    query: z.string().default(""),
    authorId: z.string().optional(),
    after: z.iso.datetime({ offset: true }).optional(),
    before: z.iso.datetime({ offset: true }).optional(),
    order: z.enum(["newest", "oldest"]).default("newest"),
    maxResults: z.number().int().min(1).max(100).default(20),
    offset: z.number().int().min(0).default(0),
    snapshotCursor: z.number().int().min(0).optional(),
    archiveSnapshotCursor: z.number().int().min(0).optional(),
  })
  .refine((value) => !value.after || !value.before || Date.parse(value.after) < Date.parse(value.before), {
    message: "after must be earlier than before",
  });
export type HistoryQuery = z.input<typeof historyQuerySchema>;

const eventHeaderSchema = z.object({
  type: z.enum(["message_create", "message_update", "message_delete", "reaction_add", "reaction_remove"]),
  guildId: z.string(),
  channelId: z.string(),
  threadId: z.string().optional(),
  messageId: z.string(),
  cursor: z.number().int().min(0).optional(),
});
const messageSchema = z.object({
  author: z.object({ id: z.string(), displayName: z.string(), isBot: z.boolean() }),
  cleanContent: z.string(),
  createdAt: z.iso.datetime({ offset: true }),
  editedAt: z.iso.datetime({ offset: true }).optional(),
  deletedAt: z.string().optional(),
});
const payloadSchema = z.object({ payload: messageSchema });
const archiveSchema = z.object({
  cursor: z.number().int(),
  guildId: z.string().optional(),
  channelIds: z.array(z.string()).optional(),
  participants: z.array(z.string()),
  time: z.iso.datetime({ offset: true }),
  summary: z.string(),
  fromEventCursor: z.number().int(),
  toEventCursor: z.number().int(),
});

export type HistorySearchResult = {
  entries: Array<{
    source: "message" | "summary";
    id: string;
    time: string;
    text: string;
    authorId?: string;
    displayName?: string;
    messageUrl?: string;
    editedAt?: string;
    truncated: boolean;
  }>;
  total: number;
  snapshotCursor: number;
  archiveSnapshotCursor: number;
  nextOffset: number | null;
};

export async function searchDiscordHistory(
  context: ToolContext,
  value: HistoryQuery,
  maxResultChars = 16_000,
): Promise<HistorySearchResult> {
  const query = historyQuerySchema.parse(value);
  if (!context.channelId) throw new Error("History search requires the current channel.");
  const eventsPath = await assertInsideWorkspace(context.workspaceRoot, "memory/events.jsonl");
  const historyPath = await assertInsideWorkspace(context.workspaceRoot, "memory/history.jsonl");
  const [rawEvents, rawArchives] = await Promise.all([
    readJsonl<unknown>(eventsPath),
    readJsonl<unknown>(historyPath),
  ]);
  const rows = rawEvents.flatMap((raw, index) => {
    const header = eventHeaderSchema.safeParse(raw);
    return header.success ? [{ raw, header: header.data, cursor: header.data.cursor ?? index + 1 }] : [];
  });
  const snapshotCursor = query.snapshotCursor ?? rows.reduce((max, row) => Math.max(max, row.cursor), 0);
  const archives = rawArchives.flatMap((raw) => {
    const parsed = archiveSchema.safeParse(raw);
    return parsed.success ? [parsed.data] : [];
  });
  const archiveSnapshotCursor =
    query.archiveSnapshotCursor ?? archives.reduce((max, entry) => Math.max(max, entry.cursor), 0);
  const deleted = new Set<string>();
  const deletedBeforeSnapshot = new Set<string>();
  const changed = new Set<number>();
  const changedAfterSnapshot = new Set<number>();
  const laterVersions = new Map<string, z.infer<typeof messageSchema>>();
  const messages = new Map<
    string,
    {
      header: z.infer<typeof eventHeaderSchema>;
      message: z.infer<typeof messageSchema>;
      cursor: number;
    }
  >();
  for (const row of rows) {
    const { header } = row;
    if (
      header.guildId !== context.guildId ||
      header.channelId !== context.channelId ||
      (context.threadId !== undefined && header.threadId !== context.threadId)
    )
      continue;
    if (header.type === "message_delete") {
      deleted.add(header.messageId);
      if (row.cursor <= snapshotCursor) deletedBeforeSnapshot.add(header.messageId);
      const old = messages.get(header.messageId);
      if (old) (row.cursor <= snapshotCursor ? changed : changedAfterSnapshot).add(old.cursor);
      continue;
    }
    if (row.cursor > snapshotCursor && header.type === "message_update") {
      const parsed = payloadSchema.safeParse(row.raw);
      if (parsed.success) laterVersions.set(header.messageId, parsed.data.payload);
      const old = messages.get(header.messageId);
      if (old) changedAfterSnapshot.add(old.cursor);
      continue;
    }
    if (row.cursor > snapshotCursor || (header.type !== "message_create" && header.type !== "message_update"))
      continue;
    const parsed = payloadSchema.safeParse(row.raw);
    if (!parsed.success) continue;
    const old = messages.get(header.messageId);
    if (header.type === "message_update" && old) changed.add(old.cursor);
    messages.set(header.messageId, {
      header,
      message: parsed.data.payload,
      cursor: old?.cursor ?? row.cursor,
    });
  }
  const matches = (text: string, time: string, authorId?: string) =>
    text.toLowerCase().includes(query.query.toLowerCase()) &&
    (!query.authorId || authorId === query.authorId) &&
    (!query.after || Date.parse(time) >= Date.parse(query.after)) &&
    (!query.before || Date.parse(time) < Date.parse(query.before));
  const entries: HistorySearchResult["entries"] = [];
  const hiddenIds = new Set<string>();
  for (const [id, item] of messages) {
    if (
      deletedBeforeSnapshot.has(id) ||
      item.message.deletedAt ||
      !matches(item.message.cleanContent, item.message.createdAt, item.message.author.id)
    )
      continue;
    const current = laterVersions.get(id) ?? item.message;
    if (
      deleted.has(id) ||
      current.deletedAt ||
      !matches(current.cleanContent, current.createdAt, current.author.id)
    )
      hiddenIds.add(id);
    const capped = truncateText(current.cleanContent, 2000);
    entries.push({
      source: "message",
      id,
      time: item.message.createdAt,
      text: capped.text,
      authorId: current.author.id,
      displayName: current.author.displayName,
      truncated: capped.truncated,
      messageUrl: `https://discord.com/channels/${context.guildId}/${context.channelId}/${id}`,
      ...(current.editedAt ? { editedAt: current.editedAt } : {}),
    });
  }
  // Mixed-channel summaries cannot establish what the current channel is allowed to see.
  for (const entry of archives) {
    if (
      (entry.guildId && entry.guildId !== context.guildId) ||
      entry.channelIds?.length !== 1 ||
      entry.channelIds[0] !== context.channelId ||
      entry.toEventCursor > snapshotCursor ||
      entry.cursor > archiveSnapshotCursor ||
      [...changed].some((cursor) => cursor >= entry.fromEventCursor && cursor <= entry.toEventCursor) ||
      (query.authorId && !entry.participants.includes(query.authorId)) ||
      !matches(entry.summary, entry.time, query.authorId)
    )
      continue;
    if (
      [...changedAfterSnapshot].some(
        (cursor) => cursor >= entry.fromEventCursor && cursor <= entry.toEventCursor,
      )
    )
      hiddenIds.add(`summary:${entry.cursor}`);
    const capped = truncateText(entry.summary, 2000);
    entries.push({
      source: "summary",
      id: `summary:${entry.cursor}`,
      time: entry.time,
      text: capped.text,
      truncated: capped.truncated,
    });
  }
  entries.sort((a, b) => {
    const time = Date.parse(a.time) - Date.parse(b.time);
    const order = time || a.id.localeCompare(b.id);
    return query.order === "oldest" ? order : -order;
  });
  const result: HistorySearchResult = {
    total: entries.length,
    snapshotCursor,
    archiveSnapshotCursor,
    nextOffset: null,
    entries: [],
  };
  let index = Math.min(query.offset, entries.length);
  while (index < entries.length && result.entries.length < query.maxResults) {
    const entry = entries[index];
    if (!entry) break;
    if (hiddenIds.has(entry.id)) {
      index += 1;
      continue;
    }
    result.entries.push(entry);
    result.nextOffset = index + 1 < entries.length ? index + 1 : null;
    if (JSON.stringify(result, null, 2).length > maxResultChars) {
      result.entries.pop();
      if (result.entries.length > 0) break;
      // Even a custom small result budget must return complete JSON and usable page metadata.
      let low = 0;
      let high = entry.text.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        const capped = truncateText(entry.text, middle);
        result.entries = [{ ...entry, text: capped.text, truncated: true }];
        if (JSON.stringify(result, null, 2).length <= maxResultChars) low = middle;
        else high = middle - 1;
      }
      result.entries = [{ ...entry, text: truncateText(entry.text, low).text, truncated: true }];
      if (JSON.stringify(result, null, 2).length > maxResultChars)
        throw new Error("History result budget is too small for pagination metadata.");
    }
    index += 1;
  }
  result.nextOffset = index < entries.length ? index : null;
  return result;
}
