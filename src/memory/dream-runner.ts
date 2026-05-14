import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildDreamContext } from "../agent/context-builder.js";
import type { AgentRunner } from "../agent/runner.js";
import { atomicWriteFile } from "../storage/atomic-write.js";
import { appendJsonl, readCursor, readJsonl, writeCursor } from "../storage/jsonl.js";
import { createToolRegistry } from "../tools/tool-registry.js";
import type { AgentRunResult, AppConfig, HistoryEntry, MemoryInboxEntry } from "../types.js";

export class DreamRunner {
  constructor(
    private readonly workspaceRoot: string,
    private readonly agentsPath: string,
    private readonly guildId: string,
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
    const inbox = await readJsonl<MemoryInboxEntry>(join(this.workspaceRoot, "memory", "inbox.jsonl"));
    const unprocessedInbox = inbox.filter((entry) => entry.processedAt === undefined);
    if (history.length === 0 && unprocessedInbox.length === 0) return undefined;

    const memory = await readTextIfExists(join(this.workspaceRoot, "memory", "MEMORY.md"));
    const watchedFiles = await collectWatchedMemoryFiles(this.workspaceRoot, history, unprocessedInbox);
    const before = await snapshotFiles(this.workspaceRoot, watchedFiles);
    const context = await buildDreamContext({
      agentsPath: this.agentsPath,
      workspaceRoot: this.workspaceRoot,
      history,
      inbox: unprocessedInbox,
      memory,
      config: this.config,
      reason,
    });
    const tools = createToolRegistry(
      this.config,
      {
        guildId: this.guildId,
        workspaceRoot: this.workspaceRoot,
      },
      {
        writePolicy: (path) => assertDreamWriteAllowed(path, this.config),
      },
    );
    const result = await this.agentRunner.run({
      sessionId: `dream:${this.guildId}`,
      messages: context,
      tools,
      traceLabel: "dream",
    });
    const after = await snapshotFiles(this.workspaceRoot, watchedFiles);
    const changedFiles = diffSnapshots(before, after);
    const maxCursor = history.at(-1)?.cursor ?? cursor;
    await writeCursor(dreamCursorPath, maxCursor);
    await markInboxProcessed(join(this.workspaceRoot, "memory", "inbox.jsonl"), inbox, unprocessedInbox);
    await appendJsonl(join(this.workspaceRoot, "memory", "dream-runs.jsonl"), {
      time: new Date().toISOString(),
      reason,
      fromCursor: cursor,
      toCursor: maxCursor,
      inboxCount: unprocessedInbox.length,
      changedFiles,
      resultPreview: result.text.slice(0, 1000),
    });
    return result;
  }
}

function assertDreamWriteAllowed(path: string, config: AppConfig): void {
  const normalized = path.replaceAll("\\", "/").replace(/^\.?\//, "");
  if (normalized === "memory/MEMORY.md") return;
  if (config.memory.dream.allowEditUserProfiles && /^users\/[^/]+\/USER\.md$/.test(normalized)) return;
  if (config.memory.dream.allowEditSoul && normalized === "SOUL.md") return;
  if (config.memory.dream.allowEditGroup && normalized === "GROUP.md") return;
  throw new Error(`Dream is not allowed to write ${path}`);
}

async function collectWatchedMemoryFiles(
  _workspaceRoot: string,
  history: HistoryEntry[],
  inbox: MemoryInboxEntry[],
): Promise<string[]> {
  const targets = new Set<string>(["memory/MEMORY.md"]);
  for (const entry of history) {
    for (const target of entry.memoryTargets) targets.add(target);
  }
  for (const entry of inbox) targets.add(entry.target);
  return [...targets].filter((path) => !path.includes("..") && !path.startsWith("/"));
}

async function snapshotFiles(workspaceRoot: string, relativePaths: string[]): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  for (const relativePath of relativePaths) {
    snapshot.set(relativePath, await readTextIfExists(join(workspaceRoot, relativePath)));
  }
  return snapshot;
}

function diffSnapshots(before: Map<string, string>, after: Map<string, string>): string[] {
  const keys = new Set([...before.keys(), ...after.keys()]);
  return [...keys].filter((key) => before.get(key) !== after.get(key)).sort();
}

async function markInboxProcessed(
  inboxPath: string,
  all: MemoryInboxEntry[],
  processed: MemoryInboxEntry[],
): Promise<void> {
  if (processed.length === 0) return;
  const processedKeys = new Set(processed.map((entry) => JSON.stringify(entry)));
  const processedAt = new Date().toISOString();
  const next = all.map((entry) =>
    processedKeys.has(JSON.stringify(entry)) && entry.processedAt === undefined
      ? { ...entry, processedAt }
      : entry,
  );
  await atomicWriteFile(inboxPath, `${next.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

async function readTextIfExists(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}
