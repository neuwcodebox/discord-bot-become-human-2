import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DreamContextInput } from "../agent/context-builder.js";
import { buildDreamPhase1Context, buildDreamPhase2Context } from "../agent/context-builder.js";
import type { AgentRunner } from "../agent/runner.js";
import { childLogger } from "../logger.js";
import { atomicWriteFile } from "../storage/atomic-write.js";
import { appendJsonl, readCursor, readJsonl, writeCursor } from "../storage/jsonl.js";
import { createToolRegistry } from "../tools/tool-registry.js";
import type { AgentRunResult, AppConfig, HistoryEntry, MemoryInboxEntry } from "../types.js";

const log = childLogger("dream-runner");

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
    const historyPath = join(this.workspaceRoot, "memory", "history.jsonl");
    const cursor = await readCursor(dreamCursorPath);
    const history = (await readJsonl<HistoryEntry>(historyPath))
      .filter((entry) => entry.cursor > cursor)
      .slice(0, this.config.memory.dream.maxHistoryEntriesPerRun);
    const inbox = await readJsonl<MemoryInboxEntry>(join(this.workspaceRoot, "memory", "inbox.jsonl"));
    const unprocessedInbox = inbox.filter((entry) => entry.processedAt === undefined);
    if (history.length === 0 && unprocessedInbox.length === 0) return undefined;

    const dream = this.config.memory.dream;

    // Pre-load all files Phase 1/2 will need
    const memory = await readTextIfExists(join(this.workspaceRoot, "memory", "MEMORY.md"));

    let soul: string | undefined;
    if (dream.allowEditSoul) {
      soul = await readTextIfExists(join(this.workspaceRoot, "SOUL.md"));
    }

    let group: string | undefined;
    if (dream.allowEditGroup) {
      group = await readTextIfExists(join(this.workspaceRoot, "GROUP.md"));
    }

    const userFiles = new Map<string, string>();
    if (dream.allowEditUserProfiles) {
      const participantIds = new Set<string>();
      for (const entry of history) {
        for (const id of entry.participants) participantIds.add(id);
      }
      await Promise.all(
        [...participantIds].map(async (id) => {
          const relativePath = `users/${id}/USER.md`;
          const content = await readTextIfExists(join(this.workspaceRoot, relativePath));
          if (content) userFiles.set(relativePath, content);
        }),
      );
    }

    const existingSkillNames = await readExistingSkillNames(this.workspaceRoot);

    const watchedFiles = await collectWatchedMemoryFiles(
      this.workspaceRoot,
      history,
      unprocessedInbox,
      dream,
    );
    const before = await snapshotFiles(this.workspaceRoot, watchedFiles);

    const contextInput: DreamContextInput = {
      agentsPath: this.agentsPath,
      workspaceRoot: this.workspaceRoot,
      history,
      inbox: unprocessedInbox,
      memory,
      userFiles,
      existingSkillNames,
      config: this.config,
      reason,
      ...(soul !== undefined ? { soul } : {}),
      ...(group !== undefined ? { group } : {}),
    };

    // Phase 1: analysis-only LLM call (no tools)
    const phase1Context = await buildDreamPhase1Context(contextInput);
    const phase1Result = await this.agentRunner.run({
      sessionId: `dream:${this.guildId}:phase1`,
      messages: phase1Context,
      tools: [],
      traceLabel: "dream:phase1",
      allowEmptyText: false,
    });
    const phase1Analysis = phase1Result.text;

    log.info({ guildId: this.guildId, analysisLength: phase1Analysis.length }, "dream phase1 complete");

    // If Phase 1 found nothing to do, skip Phase 2
    const hasWork = /\[(FILE|FILE-REMOVE|SKILL)\b/.test(phase1Analysis);
    let phase2Result: AgentRunResult | undefined;
    if (hasWork) {
      const phase2Context = await buildDreamPhase2Context(contextInput, phase1Analysis);
      const tools = createToolRegistry(
        this.config,
        { guildId: this.guildId, workspaceRoot: this.workspaceRoot },
        { writePolicy: (path) => assertDreamWriteAllowed(path, this.config) },
      );
      phase2Result = await this.agentRunner.run({
        sessionId: `dream:${this.guildId}:phase2`,
        messages: phase2Context,
        tools,
        traceLabel: "dream:phase2",
      });
    }

    const after = await snapshotFiles(this.workspaceRoot, watchedFiles);
    const changedFiles = diffSnapshots(before, after);
    const maxCursor = history.at(-1)?.cursor ?? cursor;
    await writeCursor(dreamCursorPath, maxCursor);
    await compactHistoryFile(historyPath, dream.maxHistoryEntries);
    await markInboxProcessed(join(this.workspaceRoot, "memory", "inbox.jsonl"), inbox, unprocessedInbox);
    await appendJsonl(join(this.workspaceRoot, "memory", "dream-runs.jsonl"), {
      time: new Date().toISOString(),
      reason,
      fromCursor: cursor,
      toCursor: maxCursor,
      inboxCount: unprocessedInbox.length,
      changedFiles,
      phase1Preview: phase1Analysis.slice(0, 500),
      resultPreview: phase2Result?.text.slice(0, 1000) ?? "",
    });
    return phase2Result;
  }
}

function assertDreamWriteAllowed(path: string, config: AppConfig): void {
  const normalized = path.replaceAll("\\", "/").replace(/^\.?\//, "");
  if (normalized === "memory/MEMORY.md") return;
  if (config.memory.dream.allowEditUserProfiles && /^users\/[^/]+\/USER\.md$/.test(normalized)) return;
  if (config.memory.dream.allowEditSoul && normalized === "SOUL.md") return;
  if (config.memory.dream.allowEditGroup && normalized === "GROUP.md") return;
  if (/^skills\/[^/]+\/SKILL\.md$/.test(normalized)) return;
  throw new Error(`Dream is not allowed to write ${path}`);
}

async function readExistingSkillNames(workspaceRoot: string): Promise<string[]> {
  const skillsDir = join(workspaceRoot, "skills");
  try {
    return await readdir(skillsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function compactHistoryFile(historyPath: string, maxEntries: number): Promise<void> {
  if (maxEntries <= 0) return;
  const entries = await readJsonl<HistoryEntry>(historyPath);
  if (entries.length <= maxEntries) return;
  const kept = entries.slice(entries.length - maxEntries);
  await atomicWriteFile(historyPath, `${kept.map((e) => JSON.stringify(e)).join("\n")}\n`);
}

async function collectWatchedMemoryFiles(
  _workspaceRoot: string,
  history: HistoryEntry[],
  inbox: MemoryInboxEntry[],
  dream: AppConfig["memory"]["dream"],
): Promise<string[]> {
  const targets = new Set<string>(["memory/MEMORY.md"]);
  if (dream.allowEditSoul) targets.add("SOUL.md");
  if (dream.allowEditGroup) targets.add("GROUP.md");
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
