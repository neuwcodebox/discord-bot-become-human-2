import { MemoryInbox } from "../memory/memory-inbox.js";
import { assertInsideWorkspace } from "../paths/workspace-guard.js";
import type { MemoryInboxEntry, ToolContext } from "../types.js";

export async function memoryPropose(
  context: ToolContext,
  entry: Omit<MemoryInboxEntry, "time" | "source"> & { source?: string },
  signal?: AbortSignal,
): Promise<MemoryInboxEntry> {
  await assertInsideWorkspace(context.workspaceRoot, "memory/inbox.jsonl");
  return new MemoryInbox(context.workspaceRoot).propose(
    {
      ...entry,
      source: entry.source ?? "conversation",
    },
    signal,
  );
}
