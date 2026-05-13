import { join } from "node:path";
import type { GuildMember, Message, TextBasedChannel } from "discord.js";
import { splitText } from "../discord/chunker.js";
import { sendDiscordMessage } from "../discord/sender.js";
import { readJsonl } from "../storage/jsonl.js";
import type { HistoryEntry, NormalizedDiscordEvent, ToolContext } from "../types.js";

export type DiscordActionRuntime = {
  react(messageId: string, emoji: string): Promise<void>;
  unreact(messageId: string, emoji: string): Promise<void>;
  editOwn(messageId: string, content: string): Promise<void>;
  deleteOwn(messageId: string): Promise<void>;
  getMember(userId: string): Promise<Record<string, unknown>>;
  getChannel(): Promise<Record<string, unknown>>;
  searchHistory(query: string, maxResults?: number): Promise<Array<Record<string, unknown>>>;
  sendMessage(content: string): Promise<{ messageId: string }>;
};

export function createDiscordActionRuntimeFromMessage(
  message: Message<boolean>,
  context: ToolContext,
  sendState: { firstReplySent: boolean } = { firstReplySent: false },
  limits = { softLimitChars: 1800, hardLimitChars: 1950 },
  onBeforeSend?: () => Promise<void>,
): DiscordActionRuntime {
  return {
    async react(messageId, emoji) {
      const target = await message.channel.messages.fetch(messageId);
      await target.react(emoji);
    },
    async unreact(messageId, emoji) {
      const target = await message.channel.messages.fetch(messageId);
      const reaction = target.reactions.cache.find((candidate) => candidate.emoji.toString() === emoji);
      if (!reaction) return;
      await reaction.users.remove(message.client.user?.id);
    },
    async editOwn(messageId, content) {
      const target = await message.channel.messages.fetch(messageId);
      if (target.author.id !== message.client.user?.id)
        throw new Error("discord_edit_own can edit only bot-owned messages.");
      await target.edit({ content, allowedMentions: { parse: [], repliedUser: false } });
    },
    async deleteOwn(messageId) {
      const target = await message.channel.messages.fetch(messageId);
      if (target.author.id !== message.client.user?.id) {
        throw new Error("discord_delete_own can delete only bot-owned messages.");
      }
      await target.delete();
    },
    async getMember(userId) {
      if (!message.guild) throw new Error("discord_get_member requires a guild message.");
      const member = await message.guild.members.fetch(userId);
      return serializeMember(member);
    },
    async getChannel() {
      return serializeChannel(message.channel);
    },
    async sendMessage(content) {
      await onBeforeSend?.();
      const chunks = splitText(content, limits.softLimitChars, limits.hardLimitChars);
      let lastMessageId = "";
      for (const chunk of chunks) {
        const replyTo = sendState.firstReplySent ? undefined : message;
        sendState.firstReplySent = true;
        const sent = await sendDiscordMessage(message.channel, chunk, replyTo ? { replyTo } : {});
        lastMessageId = sent.id;
      }
      return { messageId: lastMessageId };
    },
    async searchHistory(query, maxResults = 20) {
      const lower = query.toLowerCase();
      const events = await readJsonl<NormalizedDiscordEvent>(
        join(context.workspaceRoot, "memory", "events.jsonl"),
      );
      const history = await readJsonl<HistoryEntry>(join(context.workspaceRoot, "memory", "history.jsonl"));
      const eventMatches = events
        .filter((event) => JSON.stringify(event).toLowerCase().includes(lower))
        .slice(-maxResults)
        .map((event) => ({ source: "events.jsonl", ...event }));
      const remaining = Math.max(0, maxResults - eventMatches.length);
      const historyMatches = history
        .filter((entry) => JSON.stringify(entry).toLowerCase().includes(lower))
        .slice(-remaining)
        .map((entry) => ({ source: "history.jsonl", ...entry }));
      return [...eventMatches, ...historyMatches];
    },
  };
}

function serializeMember(member: GuildMember): Record<string, unknown> {
  return {
    id: member.id,
    username: member.user.username,
    displayName: member.displayName,
    avatarUrl: member.displayAvatarURL(),
    roles: member.roles.cache.filter((role) => role.id !== member.guild.id).map((role) => role.name),
  };
}

function serializeChannel(channel: TextBasedChannel): Record<string, unknown> {
  return {
    id: channel.id,
    type: channel.type,
    name: "name" in channel ? channel.name : undefined,
    topic: "topic" in channel ? channel.topic : undefined,
  };
}
