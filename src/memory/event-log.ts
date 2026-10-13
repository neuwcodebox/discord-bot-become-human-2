import { join } from "node:path";
import { z } from "zod";
import { appendJsonl, readJsonl } from "../storage/jsonl.js";
import type { NormalizedDiscordEvent } from "../types.js";

const eventCursorSchema = z.object({ cursor: z.number().int().nonnegative().optional() });

export class EventLog {
  private static readonly appends = new Map<string, Promise<void>>();
  private readonly eventsPath: string;

  constructor(workspaceRoot: string) {
    this.eventsPath = join(workspaceRoot, "memory", "events.jsonl");
  }

  async append<T extends NormalizedDiscordEvent>(event: T): Promise<T & { cursor: number }> {
    return this.serialize(async () => {
      const all = await readJsonl<unknown>(this.eventsPath);
      const cursor =
        all.reduce<number>((max, entry) => Math.max(max, eventCursorSchema.parse(entry).cursor ?? 0), 0) + 1;
      const withCursor = { ...event, cursor };
      await appendJsonl(this.eventsPath, withCursor);
      return withCursor;
    });
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = (EventLog.appends.get(this.eventsPath) ?? Promise.resolve()).then(operation);
    const settled = next.then(
      () => {},
      () => {},
    );
    EventLog.appends.set(this.eventsPath, settled);
    void settled.then(() => {
      if (EventLog.appends.get(this.eventsPath) === settled) EventLog.appends.delete(this.eventsPath);
    });
    return next;
  }

  async readAll(): Promise<NormalizedDiscordEvent[]> {
    // Register the read before yielding so later appends cannot change this snapshot.
    return this.serialize(() => readJsonl<NormalizedDiscordEvent>(this.eventsPath));
  }

  async readRecent(limit: number): Promise<NormalizedDiscordEvent[]> {
    const all = await this.readAll();
    return all.slice(Math.max(0, all.length - limit));
  }
}
