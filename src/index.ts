import "./bootstrap-env.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Events } from "discord.js";
import { Langfuse } from "langfuse";
import { OpenAICompatibleAgentRunner, PiCodexAgentRunner } from "./agent/runner.js";
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
    join(homedir(), ".discord-bot-become-human-2", "config.json"),
  );
  const paths = createRuntimePaths(projectRoot, bootstrapConfig);
  const config = await loadOrCreateConfig(paths.configPath);
  const runtime = await ensureRuntimeRoot(paths);
  log.info(
    {
      projectRoot,
      runtimeRoot: paths.runtimeRoot,
      configPath: paths.configPath,
      ...(paths.codexAuthPath !== undefined ? { codexAuthPath: paths.codexAuthPath } : {}),
      logLevel: process.env.LOG_LEVEL ?? process.env.BOT_LOG_LEVEL ?? "info",
    },
    "runtime initialized",
  );
  if (config.llm.provider === "openai-codex" && !runtime.codexAuthExists) {
    log.warn(
      `Codex auth file not found at ${paths.codexAuthPath ?? ""}. Run from this project root: npm run login:codex`,
    );
  }

  const lfConfig = config.observability?.langfuse;
  let langfuse: Langfuse | null = null;
  if (lfConfig) {
    const pk = process.env[lfConfig.publicKeyEnv];
    const sk = process.env[lfConfig.secretKeyEnv];
    if (pk && sk) {
      langfuse = new Langfuse({ publicKey: pk, secretKey: sk, baseUrl: lfConfig.host, flushInterval: 5000 });
      log.info({ host: lfConfig.host }, "langfuse observability enabled");
    } else {
      log.warn(
        { publicKeyEnv: lfConfig.publicKeyEnv, secretKeyEnv: lfConfig.secretKeyEnv },
        "langfuse config present but env vars missing — observability disabled",
      );
    }
  }

  const client = createDiscordClient(config);
  const llm = config.llm;
  const runner =
    llm.provider === "openai-codex"
      ? new PiCodexAgentRunner({ ...config, llm }, langfuse)
      : new OpenAICompatibleAgentRunner({ ...config, llm }, langfuse);
  const botIdentity: { userId?: string; names: string[] } = { names: ["bot"] };
  const orchestrator = new ConversationOrchestrator(config, paths.resourcesAgentsPath, runner, botIdentity);
  wireDiscordEvents({ client, config, paths, orchestrator });

  const shutdown = async () => {
    await langfuse?.shutdownAsync();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());

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

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
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
