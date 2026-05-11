import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type LoadedMemory = {
  guildMemory: string;
};

export async function loadMemory(workspaceRoot: string): Promise<LoadedMemory> {
  return {
    guildMemory: await readTextIfExists(join(workspaceRoot, "memory", "MEMORY.md")),
  };
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
