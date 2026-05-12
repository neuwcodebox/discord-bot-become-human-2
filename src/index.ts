import "./bootstrap-env.js";
import { Events } from "discord.js";
import { PiCodexAgentRunner } from "./agent/runner.js";
import { loadOrCreateConfig } from "./config.js";
import { ConversationOrchestrator } from "./conversation/orchestrator.js";
import { createDiscordClient, loginDiscord, wireDiscordEvents } from "./discord/client.js";
import { childLogger } from "./logger.js";
import { createRuntimePaths, projectRootFromImportMeta } from "./paths/runtime-paths.js";
import { ensureRuntimeRoot } from "./paths/workspace-init.js";

const log = childLogger("main");

export async function main(): Promise<void> {
  const projectRoot = projectRootFromImportMeta(import.meta.url);
  const bootstrapConfig = await loadOrCreateConfig(
    `${process.env.HOME}/.discord-bot-become-human-2/config.json`,
  );
  const paths = createRuntimePaths(projectRoot, bootstrapConfig);
  const config = await loadOrCreateConfig(paths.configPath);
  const runtime = await ensureRuntimeRoot(paths);
  log.info(
    {
      projectRoot,
      runtimeRoot: paths.runtimeRoot,
      configPath: paths.configPath,
      codexAuthPath: paths.codexAuthPath,
      logLevel: process.env.LOG_LEVEL ?? process.env.BOT_LOG_LEVEL ?? "info",
    },
    "runtime initialized",
  );
  if (!runtime.codexAuthExists) {
    log.warn(
      `Codex auth file not found at ${paths.codexAuthPath}. Run from this project root: npm run login:codex`,
    );
  }

  const client = createDiscordClient(config);
  const runner = new PiCodexAgentRunner(config);
  const botIdentity: { userId?: string; names: string[] } = { names: ["bot"] };
  const orchestrator = new ConversationOrchestrator(config, paths.resourcesAgentsPath, runner, botIdentity);
  wireDiscordEvents({ client, config, paths, orchestrator });
  client.once(Events.ClientReady, (readyClient) => {
    botIdentity.userId = readyClient.user.id;
    botIdentity.names = [
      ...new Set(
        [
          readyClient.user.username,
          readyClient.user.globalName,
          readyClient.user.tag,
          ...botIdentity.names,
        ].filter((name): name is string => Boolean(name)),
      ),
    ];
    log.info({ userId: readyClient.user.id, tag: readyClient.user.tag }, "discord client ready");
  });
  await loginDiscord(client, config);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    log.error({ err: error }, "fatal startup error");
    process.exitCode = 1;
  });
}

export * from "./config.js";
export * from "./paths/runtime-paths.js";
export * from "./paths/workspace-guard.js";
export * from "./paths/workspace-init.js";
export * from "./types.js";
