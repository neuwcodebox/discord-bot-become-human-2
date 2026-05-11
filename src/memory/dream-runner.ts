import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildDreamContext } from "../agent/context-builder.js";
import type { AgentRunner } from "../agent/runner.js";
import { appendJsonl, readCursor, readJsonl, writeCursor } from "../storage/jsonl.js";
import type { AgentRunResult, AppConfig, HistoryEntry, MemoryInboxEntry } from "../types.js";

export class DreamRunner {
  constructor(
    private readonly workspaceRoot: string,
    private readonly config: AppConfig,
    private readonly agentRunner: AgentRunner,
  ) {}

  async run(reason: string): Promise<AgentRunResult | undefined> {
    if (!this.config.memory.dream.enabled) return undefined;
    const dreamCursorPath = join(this.workspaceRoot, "memory", ".dream_cursor");
    const cursor = await readCursor(dreamCursorPath);
    const history = (await readJsonl<HistoryEntry>(join(this.workspaceRoot, "memory", "history.jsonl")))
      .filter((entry) => entry.cursor > cursor)
      .slice(0, this.config.memory.dream.maxHistoryEntriesPerRun);
    const inbox = (
      await readJsonl<MemoryInboxEntry>(join(this.workspaceRoot, "memory", "inbox.jsonl"))
    ).filter((entry) => entry.processedAt === undefined);
    if (history.length === 0 && inbox.length === 0) return undefined;

    const memory = await readTextIfExists(join(this.workspaceRoot, "memory", "MEMORY.md"));
    const context = await buildDreamContext({
      workspaceRoot: this.workspaceRoot,
      history,
      inbox,
      memory,
      config: this.config,
      reason,
    });
    const result = await this.agentRunner.run({
      sessionId: `dream:${this.workspaceRoot}`,
      messages: context,
    });
    const maxCursor = history.at(-1)?.cursor ?? cursor;
    await writeCursor(dreamCursorPath, maxCursor);
    await appendJsonl(join(this.workspaceRoot, "memory", "dream-runs.jsonl"), {
      time: new Date().toISOString(),
      reason,
      fromCursor: cursor,
      toCursor: maxCursor,
      inboxCount: inbox.length,
      resultPreview: result.text.slice(0, 1000),
    });
    return result;
  }
}

async function readTextIfExists(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}
