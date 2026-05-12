import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { truncateText } from "../context/limits.js";
import { readJsonl } from "../storage/jsonl.js";
import type { AppConfig, HistoryEntry } from "../types.js";

export type LoadedMemory = {
  guildMemory: string;
};

export async function loadMemory(workspaceRoot: string): Promise<LoadedMemory> {
  return {
    guildMemory: await readTextIfExists(join(workspaceRoot, "memory", "MEMORY.md")),
  };
}

export async function loadRecentArchiveSummaries(input: {
  workspaceRoot: string;
  config: AppConfig;
  channelId?: string;
}): Promise<string> {
  const entries = await readJsonl<HistoryEntry>(join(input.workspaceRoot, "memory", "history.jsonl"));
  const filtered = entries.filter((entry) => {
    if (!input.channelId || !entry.channelIds || entry.channelIds.length === 0) return true;
    return entry.channelIds.includes(input.channelId);
  });
  const recent = filtered.slice(-input.config.context.maxArchiveSummariesInContext);
  return recent
    .map((entry) => {
      const summary = truncateText(entry.summary, input.config.context.maxArchiveSummaryChars).text;
      return `- #${entry.cursor} ${entry.time} events ${entry.fromEventCursor}-${entry.toEventCursor}: ${summary}`;
    })
    .join("\n");
}

export async function loadWorkspaceDocuments(workspaceRoot: string): Promise<{
  soul: string;
  group: string;
  tools: string;
}> {
  return {
    soul: await readTextIfExists(join(workspaceRoot, "SOUL.md")),
    group: await readTextIfExists(join(workspaceRoot, "GROUP.md")),
    tools: await readTextIfExists(join(workspaceRoot, "TOOLS.md")),
  };
}

async function readTextIfExists(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}
