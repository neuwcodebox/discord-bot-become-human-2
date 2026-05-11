import { join } from "node:path";
import { appendJsonl, readCursor, readJsonl, writeCursor } from "../storage/jsonl.js";
import type { NormalizedDiscordEvent } from "../types.js";

export class EventLog {
  private readonly eventsPath: string;
  private readonly cursorPath: string;

  constructor(workspaceRoot: string) {
    this.eventsPath = join(workspaceRoot, "memory", "events.jsonl");
    this.cursorPath = join(workspaceRoot, "memory", ".cursor");
  }

  async append(event: NormalizedDiscordEvent): Promise<NormalizedDiscordEvent> {
    const cursor = (await readCursor(this.cursorPath)) + 1;
    const withCursor = { ...event, cursor };
    await appendJsonl(this.eventsPath, withCursor);
    await writeCursor(this.cursorPath, cursor);
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
