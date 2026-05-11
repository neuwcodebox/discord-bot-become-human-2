import { constants } from "node:fs";
import { access, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GuildWorkspace, RuntimePaths } from "../types.js";

const emptyJsonlFiles = ["events.jsonl", "history.jsonl", "inbox.jsonl", "dream-runs.jsonl"];
const cursorFiles = [".cursor", ".dream_cursor"];

export async function ensureRuntimeRoot(paths: RuntimePaths): Promise<{ codexAuthExists: boolean }> {
  await mkdir(paths.runtimeRoot, { recursive: true });
  await mkdir(paths.guildsRoot, { recursive: true });
  return { codexAuthExists: await exists(paths.codexAuthPath) };
}

export async function ensureGuildWorkspace(paths: RuntimePaths, workspace: GuildWorkspace): Promise<void> {
  await mkdir(workspace.guildRoot, { recursive: true });
  if (!(await exists(workspace.workspaceRoot))) {
    await cp(paths.templatesWorkspaceRoot, workspace.workspaceRoot, {
      recursive: true,
      errorOnExist: false,
      force: false,
    });
  }
  await repairWorkspace(workspace.workspaceRoot, paths.templatesWorkspaceRoot);
}

export async function ensureUserProfile(
  workspaceRoot: string,
  user: { id: string; username: string; displayName: string; isBot?: boolean },
  now = new Date(),
): Promise<void> {
  if (user.isBot) return;
  const userRoot = join(workspaceRoot, "users", user.id);
  await mkdir(userRoot, { recursive: true });
  const profilePath = join(userRoot, "USER.md");
  if (!(await exists(profilePath))) {
    await writeFile(profilePath, userProfileTemplate(user.id, user.displayName), "utf8");
  }
  const aliasesPath = join(userRoot, "aliases.json");
  const iso = now.toISOString();
  const aliases = await readJsonObject<{
    currentDisplayName?: string;
    usernames?: string[];
    displayNames?: string[];
    firstSeenAt?: string;
    lastSeenAt?: string;
  }>(aliasesPath);
  const next = {
    currentDisplayName: user.displayName,
    usernames: appendUnique(aliases.usernames ?? [], user.username),
    displayNames: appendUnique(aliases.displayNames ?? [], user.displayName),
    firstSeenAt: aliases.firstSeenAt ?? iso,
    lastSeenAt: iso,
  };
  await writeFile(aliasesPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

async function repairWorkspace(workspaceRoot: string, templateRoot: string): Promise<void> {
  await mkdir(join(workspaceRoot, "memory"), { recursive: true });
  await mkdir(join(workspaceRoot, "users"), { recursive: true });
  await mkdir(join(workspaceRoot, "skills"), { recursive: true });

  for (const name of ["SOUL.md", "GROUP.md", "TOOLS.md", "memory/MEMORY.md"]) {
    await copyTemplateIfMissing(templateRoot, workspaceRoot, name);
  }
  for (const skill of [
    "memory",
    "skill-creator",
    "summarize",
    "weather",
    "workspace-files",
    "discord-actions",
  ]) {
    await copyTemplateIfMissing(templateRoot, workspaceRoot, `skills/${skill}/SKILL.md`);
  }
  for (const file of emptyJsonlFiles) {
    await ensureFile(join(workspaceRoot, "memory", file), "");
  }
  for (const file of cursorFiles) {
    await ensureFile(join(workspaceRoot, "memory", file), "0\n");
  }
}

async function copyTemplateIfMissing(
  templateRoot: string,
  workspaceRoot: string,
  relativePath: string,
): Promise<void> {
  const destination = join(workspaceRoot, relativePath);
  if (await exists(destination)) return;
  await mkdir(join(destination, ".."), { recursive: true });
  await writeFile(destination, await readFile(join(templateRoot, relativePath), "utf8"), "utf8");
}

async function ensureFile(path: string, contents: string): Promise<void> {
  if (await exists(path)) return;
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, contents, "utf8");
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readJsonObject<T extends object>(path: string): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {} as T;
    throw error;
  }
}

function appendUnique(values: string[], next: string): string[] {
  return values.includes(next) ? values : [...values, next];
}

function userProfileTemplate(userId: string, displayName: string): string {
  return `# User Profile

## Identity
- Discord User ID: ${userId}
- Current display name: ${displayName}
- Known aliases:

## Stable Facts
-

## Communication Style
-

## Relationship in this server
-

## Preferences
-

## Notes
-
`;
}
