import type { Message } from "discord.js";
import type { ConversationOrchestrator } from "../conversation/orchestrator.js";
import { childLogger } from "../logger.js";
import { getGuildWorkspace } from "../paths/runtime-paths.js";
import { ensureGuildWorkspace } from "../paths/workspace-init.js";
import type { AppConfig, RuntimePaths } from "../types.js";
import { editOwnMessage, sendDiscordMessage } from "./sender.js";

const log = childLogger("admin-commands");
const ADMIN_PREFIX = "/admin ";

export function isAdminCommand(content: string): boolean {
  return content.trimStart().startsWith(ADMIN_PREFIX);
}

export function isAdminUser(config: AppConfig, userId: string): boolean {
  return config.discord.adminUserIds.includes(userId);
}

export async function handleAdminCommand(input: {
  message: Message<boolean>;
  config: AppConfig;
  paths: RuntimePaths;
  orchestrator: ConversationOrchestrator;
}): Promise<boolean> {
  const { message, config, paths, orchestrator } = input;
  const content = message.content.trimStart();
  if (!content.startsWith(ADMIN_PREFIX)) return false;

  const subcommand = content.slice(ADMIN_PREFIX.length).trim().toLowerCase();
  if (subcommand !== "compact" && subcommand !== "dream") return false;
  if (!message.guildId) return false;

  if (!isAdminUser(config, message.author.id)) {
    log.warn(
      { userId: message.author.id, subcommand, guildId: message.guildId },
      "admin command rejected: user not in adminUserIds",
    );
    await sendDiscordMessage(message.channel, "권한이 없습니다.", { replyTo: message });
    return true;
  }

  const workspace = getGuildWorkspace(paths, message.guildId);
  await ensureGuildWorkspace(paths, workspace);

  if (subcommand === "compact") {
    const statusMsg = await sendDiscordMessage(message.channel, "compaction 시작 중...", {
      replyTo: message,
    });
    try {
      const entry = await orchestrator.adminForceCompact(workspace);
      await editOwnMessage(
        statusMsg,
        entry
          ? `compaction 완료. (fromCursor=${entry.fromEventCursor}, toCursor=${entry.toEventCursor})`
          : "compaction 완료 (처리할 이벤트 없음).",
      );
      log.info({ guildId: message.guildId, compacted: entry !== undefined }, "admin compact done");
    } catch (error) {
      await editOwnMessage(statusMsg, `compaction 실패: ${String(error)}`);
      log.error({ err: error, guildId: message.guildId }, "admin compact failed");
    }
    return true;
  }

  const statusMsg = await sendDiscordMessage(message.channel, "dream 시작 중...", { replyTo: message });
  try {
    const ran = await orchestrator.adminForceDream(workspace);
    await editOwnMessage(statusMsg, ran ? "dream 완료." : "dream 완료 (처리할 항목 없음).");
    log.info({ guildId: message.guildId, ran }, "admin dream done");
  } catch (error) {
    await editOwnMessage(statusMsg, `dream 실패: ${String(error)}`);
    log.error({ err: error, guildId: message.guildId }, "admin dream failed");
  }
  return true;
}
