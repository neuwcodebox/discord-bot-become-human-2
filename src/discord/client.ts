import { Client, GatewayIntentBits, Partials } from "discord.js";
import type { ConversationOrchestrator } from "../conversation/orchestrator.js";
import { childLogger } from "../logger.js";
import { EventLog } from "../memory/event-log.js";
import { getGuildWorkspace } from "../paths/runtime-paths.js";
import { ensureGuildWorkspace, ensureUserProfile } from "../paths/workspace-init.js";
import type { AppConfig, RuntimePaths } from "../types.js";
import { handleAdminCommand, isAdminCommand } from "./admin-commands.js";
import {
  normalizeMessageCreate,
  normalizeMessageDelete,
  normalizeMessageUpdate,
  normalizeReaction,
} from "./normalizer.js";

const log = childLogger("discord");

export function createDiscordClient(_config: AppConfig): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.GuildMembers,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction],
  });
}

export function wireDiscordEvents(input: {
  client: Client;
  config: AppConfig;
  paths: RuntimePaths;
  orchestrator: ConversationOrchestrator;
}): void {
  const { client, config, paths, orchestrator } = input;
  client.on("messageCreate", async (message) => {
    if (!message.guildId) return;
    if (!isAllowed(config, message.guildId, message.channelId)) {
      log.debug(
        { event: "message_create", guildId: message.guildId, channelId: message.channelId },
        "discord event ignored by allowlist",
      );
      return;
    }
    if (!message.author.bot && isAdminCommand(message.content ?? "")) {
      const handled = await handleAdminCommand({ message, config, paths, orchestrator });
      if (handled) return;
    }
    const workspace = getGuildWorkspace(paths, message.guildId);
    await ensureGuildWorkspace(paths, workspace);
    const event = await normalizeMessageCreate(message);
    log.debug(
      {
        event: event.type,
        guildId: event.guildId,
        channelId: event.channelId,
        messageId: event.messageId,
        authorId: event.authorId,
        authorIsBot: event.payload.author.isBot,
        contentLength: event.payload.cleanContent.length,
        attachmentCount: event.payload.attachments.length,
      },
      "discord message normalized",
    );
    await ensureUserProfile(workspace.workspaceRoot, event.payload.author);
    await new EventLog(workspace.workspaceRoot).append(event);
    await orchestrator.onMessage(event, workspace, message);
  });

  client.on("messageUpdate", async (_oldMessage, newMessage) => {
    if (!newMessage.guildId) return;
    if (!isAllowed(config, newMessage.guildId, newMessage.channelId)) {
      log.debug(
        { event: "message_update", guildId: newMessage.guildId, channelId: newMessage.channelId },
        "discord event ignored by allowlist",
      );
      return;
    }
    const workspace = getGuildWorkspace(paths, newMessage.guildId);
    await ensureGuildWorkspace(paths, workspace);
    const event = await normalizeMessageUpdate(newMessage);
    log.debug(
      {
        event: event.type,
        guildId: event.guildId,
        channelId: event.channelId,
        messageId: event.messageId,
        authorId: event.authorId,
      },
      "discord message update normalized",
    );
    await new EventLog(workspace.workspaceRoot).append(event);
  });

  client.on("messageDelete", async (message) => {
    if (!message.guildId) return;
    if (!isAllowed(config, message.guildId, message.channelId)) {
      log.debug(
        { event: "message_delete", guildId: message.guildId, channelId: message.channelId },
        "discord event ignored by allowlist",
      );
      return;
    }
    const workspace = getGuildWorkspace(paths, message.guildId);
    await ensureGuildWorkspace(paths, workspace);
    const event = normalizeMessageDelete(message);
    if (event) {
      log.debug(
        {
          event: event.type,
          guildId: event.guildId,
          channelId: event.channelId,
          messageId: event.messageId,
          authorId: event.authorId,
        },
        "discord message delete normalized",
      );
      await new EventLog(workspace.workspaceRoot).append(event);
    }
  });

  client.on("messageReactionAdd", async (reaction, user) => {
    const event = normalizeReaction("reaction_add", reaction, user);
    if (!event || !isAllowed(config, event.guildId, event.channelId)) return;
    if (event.type !== "reaction_add") return;
    log.debug(
      {
        event: event.type,
        guildId: event.guildId,
        channelId: event.channelId,
        messageId: event.messageId,
        authorId: event.authorId,
        emoji: event.payload.emoji,
      },
      "discord reaction normalized",
    );
    const workspace = getGuildWorkspace(paths, event.guildId);
    await ensureGuildWorkspace(paths, workspace);
    await new EventLog(workspace.workspaceRoot).append(event);
  });

  client.on("messageReactionRemove", async (reaction, user) => {
    const event = normalizeReaction("reaction_remove", reaction, user);
    if (!event || !isAllowed(config, event.guildId, event.channelId)) return;
    if (event.type !== "reaction_remove") return;
    log.debug(
      {
        event: event.type,
        guildId: event.guildId,
        channelId: event.channelId,
        messageId: event.messageId,
        authorId: event.authorId,
        emoji: event.payload.emoji,
      },
      "discord reaction normalized",
    );
    const workspace = getGuildWorkspace(paths, event.guildId);
    await ensureGuildWorkspace(paths, workspace);
    await new EventLog(workspace.workspaceRoot).append(event);
  });
}

export async function loginDiscord(client: Client, config: AppConfig): Promise<void> {
  const token = process.env[config.discord.tokenEnv];
  if (!token) throw new Error(`Discord token env var is not set: ${config.discord.tokenEnv}`);
  await client.login(token);
}

function isAllowed(config: AppConfig, guildId: string, channelId: string): boolean {
  const guildAllowed =
    config.discord.allowedGuildIds.length === 0 || config.discord.allowedGuildIds.includes(guildId);
  const channelAllowed =
    config.discord.allowedChannelIds.length === 0 || config.discord.allowedChannelIds.includes(channelId);
  return guildAllowed && channelAllowed;
}
