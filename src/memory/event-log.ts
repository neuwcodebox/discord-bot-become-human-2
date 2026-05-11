import { join } from "node:path";
import { appendJsonl, readJsonl } from "../storage/jsonl.js";
import type { NormalizedDiscordEvent } from "../types.js";

export class EventLog {
  private readonly eventsPath: string;

  constructor(workspaceRoot: string) {
    this.eventsPath = join(workspaceRoot, "memory", "events.jsonl");
  }

  async append(event: NormalizedDiscordEvent): Promise<NormalizedDiscordEvent> {
    const all = await this.readAll();
    const cursor = Math.max(0, ...all.map((entry) => entry.cursor ?? 0)) + 1;
    const withCursor = { ...event, cursor };
    await appendJsonl(this.eventsPath, withCursor);
    return withCursor;
  }

  async readAll(): Promise<NormalizedDiscordEvent[]> {
    return readJsonl<NormalizedDiscordEvent>(this.eventsPath);
  }

  async readRecent(limit: number): Promise<NormalizedDiscordEvent[]> {
    const all = await this.readAll();
    return all.slice(Math.max(0, all.length - limit));
  }
}
