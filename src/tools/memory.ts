import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { MemoryInbox } from "../memory/memory-inbox.js";
import type { MemoryInboxEntry, ToolContext } from "../types.js";

export async function memoryRead(context: ToolContext): Promise<string> {
  return readFile(join(context.workspaceRoot, "memory", "MEMORY.md"), "utf8");
}

export async function memoryPropose(
  context: ToolContext,
  entry: Omit<MemoryInboxEntry, "time" | "source"> & { source?: string },
): Promise<MemoryInboxEntry> {
  return new MemoryInbox(context.workspaceRoot).propose({
    ...entry,
    source: entry.source ?? "conversation",
  });
}
