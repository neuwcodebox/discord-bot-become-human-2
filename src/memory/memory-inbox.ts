import { join } from "node:path";
import { appendJsonl, readJsonl } from "../storage/jsonl.js";
import type { MemoryInboxEntry } from "../types.js";

export class MemoryInbox {
  private readonly inboxPath: string;

  constructor(workspaceRoot: string) {
    this.inboxPath = join(workspaceRoot, "memory", "inbox.jsonl");
  }

  async propose(entry: Omit<MemoryInboxEntry, "time"> & { time?: string }): Promise<MemoryInboxEntry> {
    const next: MemoryInboxEntry = {
      time: entry.time ?? new Date().toISOString(),
      source: entry.source,
      target: entry.target,
      confidence: entry.confidence,
      note: entry.note,
      evidenceMessageIds: entry.evidenceMessageIds,
      ...(entry.processedAt === undefined ? {} : { processedAt: entry.processedAt }),
    };
    await appendJsonl(this.inboxPath, next);
    return next;
  }

  async listUnprocessed(): Promise<MemoryInboxEntry[]> {
    return (await readJsonl<MemoryInboxEntry>(this.inboxPath)).filter(
      (entry) => entry.processedAt === undefined,
    );
  }
}
