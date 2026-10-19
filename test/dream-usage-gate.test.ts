import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgentUnavailableError } from "../src/agent/availability.js";
import type { AgentRunner } from "../src/agent/runner.js";
import { defaultConfig } from "../src/config.js";
import { DreamRunner } from "../src/memory/dream-runner.js";
import { MemoryInbox } from "../src/memory/memory-inbox.js";
import { appendJsonl, readJsonl } from "../src/storage/jsonl.js";
import type { HistoryEntry } from "../src/types.js";
import { createTestWorkspace } from "./helpers/workspace.js";

describe("Dream subscription gate", () => {
  it("skips scheduled and admin runs while unavailable", async () => {
    const root = await createTestWorkspace();
    const run = vi.fn<AgentRunner["run"]>();
    const dream = new DreamRunner(root, join(root, "missing-instructions"), "guild", defaultConfig, {
      run,
      isAvailable: () => false,
    });
    await expect(dream.run("interval")).resolves.toBeUndefined();
    await expect(dream.run("admin")).resolves.toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });

  it.each([1, 2])("preserves history and inbox when paused in phase %s", async (phase) => {
    const root = await createTestWorkspace();
    const agentsPath = join(root, "AGENTS.md");
    await writeFile(agentsPath, "instructions");
    const history: HistoryEntry = {
      cursor: 1,
      time: "2026-01-01T00:00:00Z",
      fromEventCursor: 1,
      toEventCursor: 2,
      participants: [],
      summary: "pending memory",
      memoryTargets: ["memory/MEMORY.md"],
    };
    const historyPath = join(root, "memory", "history.jsonl");
    await appendJsonl(historyPath, history);
    const inbox = new MemoryInbox(root);
    await inbox.propose({
      source: "conversation",
      target: "memory/MEMORY.md",
      confidence: 1,
      note: "pending note",
      evidenceMessageIds: [],
    });
    const run = vi.fn<AgentRunner["run"]>();
    if (phase === 2) run.mockResolvedValueOnce({ text: "[FILE memory/MEMORY.md] update memory" });
    run.mockRejectedValueOnce(new AgentUnavailableError());
    const dream = new DreamRunner(root, agentsPath, "guild", defaultConfig, { run });
    await expect(dream.run("interval")).rejects.toBeInstanceOf(AgentUnavailableError);
    expect(run).toHaveBeenCalledTimes(phase);
    await expect(readFile(join(root, "memory", ".dream_cursor"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await inbox.listUnprocessed()).toHaveLength(1);
    expect(await readJsonl<HistoryEntry>(historyPath)).toEqual([history]);
  });
});
