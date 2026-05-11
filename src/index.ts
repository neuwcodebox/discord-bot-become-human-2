import { PiCodexAgentRunner } from "./agent/runner.js";
import { loadOrCreateConfig } from "./config.js";
import { ConversationOrchestrator } from "./conversation/orchestrator.js";
import { createDiscordClient, loginDiscord, wireDiscordEvents } from "./discord/client.js";
import { createRuntimePaths, projectRootFromImportMeta } from "./paths/runtime-paths.js";
import { ensureRuntimeRoot } from "./paths/workspace-init.js";

export async function main(): Promise<void> {
  const projectRoot = projectRootFromImportMeta(import.meta.url);
  const bootstrapConfig = await loadOrCreateConfig(
    `${process.env.HOME}/.discord-bot-become-human-2/config.json`,
  );
  const paths = createRuntimePaths(projectRoot, bootstrapConfig);
  const config = await loadOrCreateConfig(paths.configPath);
  const runtime = await ensureRuntimeRoot(paths);
  if (!runtime.codexAuthExists) {
    console.warn(
      `Codex auth file not found at ${paths.codexAuthPath}. Falling back to ./auth.json from pi-ai. ` +
        "If needed, run from this project root: npx @earendil-works/pi-ai login openai-codex",
    );
  }

  const client = createDiscordClient(config);
  const runner = new PiCodexAgentRunner(config);
  const orchestrator = new ConversationOrchestrator(config, paths.resourcesAgentsPath, runner, {
    ...(client.user?.id ? { userId: client.user.id } : {}),
    names: ["bot"],
  });
  wireDiscordEvents({ client, config, paths, orchestrator });
  client.once("ready", (readyClient) => {
    console.log(`Logged in as ${readyClient.user.tag}`);
  });
  await loginDiscord(client, config);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export * from "./config.js";
export * from "./paths/runtime-paths.js";
export * from "./paths/workspace-guard.js";
export * from "./paths/workspace-init.js";
export * from "./types.js";
