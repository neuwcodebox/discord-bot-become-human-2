import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppConfig, GuildWorkspace, RuntimePaths } from "../types.js";

export function expandHome(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return join(homedir(), input.slice(2));
  return input;
}

export function projectRootFromImportMeta(importMetaUrl: string): string {
  const current = fileURLToPath(importMetaUrl);
  return resolve(dirname(current), "..");
}

export function createRuntimePaths(projectRoot: string, config: AppConfig): RuntimePaths {
  const runtimeRoot = resolve(expandHome(config.runtime.rootDir));
  const codexAuthPath = resolve(expandHome(config.llm.codex.authPath));
  return {
    projectRoot,
    resourcesAgentsPath: join(projectRoot, "resources", "AGENTS.md"),
    templatesWorkspaceRoot: join(projectRoot, "templates", "workspace"),
    runtimeRoot,
    configPath: join(runtimeRoot, "config.json"),
    codexAuthPath,
    guildsRoot: join(runtimeRoot, "guilds"),
  };
}

export function getGuildWorkspace(paths: RuntimePaths, guildId: string): GuildWorkspace {
  const guildRoot = join(paths.guildsRoot, guildId);
  return {
    guildId,
    guildRoot,
    workspaceRoot: join(guildRoot, "workspace"),
  };
}
