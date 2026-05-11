import type {
  Embed,
  Message,
  MessageReaction,
  PartialMessage,
  PartialMessageReaction,
  PartialUser,
  User,
} from "discord.js";
import type { AttachmentKind, NormalizedDiscordEvent, NormalizedDiscordMessage } from "../types.js";

const linkPattern = /\bhttps?:\/\/[^\s<>()]+/gi;

export async function normalizeMessage(
  message: Message<boolean> | PartialMessage,
): Promise<NormalizedDiscordMessage> {
  if (!message.guildId) throw new Error("Cannot normalize a message without guildId.");
  if (!message.author) throw new Error("Cannot normalize a partial message without author.");
  const member = "member" in message ? message.member : undefined;
  const displayName = member?.displayName ?? message.author.globalName ?? message.author.username;
  const threadId = message.channel.isThread() ? message.channel.id : undefined;
  const channelId = message.channel.isThread()
    ? (message.channel.parentId ?? message.channelId)
    : message.channelId;
  const reference = await resolveReply(message);
  const cleanContent =
    ("cleanContent" in message ? message.cleanContent : (message as { content?: string }).content) ?? "";

  return {
    id: message.id,
    guildId: message.guildId,
    channelId,
    ...(threadId ? { threadId } : {}),
    author: {
      id: message.author.id,
      username: message.author.username,
      displayName,
      isBot: message.author.bot,
    },
    content: (message as { content?: string }).content ?? "",
    cleanContent,
    createdAt: message.createdAt?.toISOString() ?? new Date().toISOString(),
    ...(message.editedAt ? { editedAt: message.editedAt.toISOString() } : {}),
    ...(reference ? { replyTo: reference } : {}),
    mentions: [...message.mentions.users.values()].map((user) => ({
      id: user.id,
      displayName: message.guild?.members.cache.get(user.id)?.displayName ?? user.globalName ?? user.username,
    })),
    attachments: [...message.attachments.values()].map((attachment) => ({
      id: attachment.id,
      url: attachment.url,
      filename: attachment.name,
      ...(attachment.contentType ? { mimeType: attachment.contentType } : {}),
      size: attachment.size,
      kind: classifyAttachment(attachment.contentType, attachment.name),
    })),
    embeds: message.embeds.map(normalizeEmbed),
    reactions: [...message.reactions.cache.values()].map((reaction) => ({
      emoji: reaction.emoji.toString(),
      count: reaction.count,
      me: reaction.me,
    })),
    links: [...(cleanContent.match(linkPattern) ?? [])],
  };
}

export async function normalizeMessageCreate(
  message: Message<boolean>,
): Promise<Extract<NormalizedDiscordEvent, { type: "message_create" }>> {
  const normalized = await normalizeMessage(message);
  return {
    type: "message_create",
    time: new Date().toISOString(),
    guildId: normalized.guildId,
    channelId: normalized.channelId,
    ...(normalized.threadId ? { threadId: normalized.threadId } : {}),
    messageId: normalized.id,
    authorId: normalized.author.id,
    payload: normalized,
  };
}

export async function normalizeMessageUpdate(
  message: Message<boolean> | PartialMessage,
): Promise<Extract<NormalizedDiscordEvent, { type: "message_update" }>> {
  const normalized = await normalizeMessage(message);
  return {
    type: "message_update",
    time: new Date().toISOString(),
    guildId: normalized.guildId,
    channelId: normalized.channelId,
    ...(normalized.threadId ? { threadId: normalized.threadId } : {}),
    messageId: normalized.id,
    authorId: normalized.author.id,
    payload: normalized,
  };
}

export function normalizeMessageDelete(
  message: Message<boolean> | PartialMessage,
): NormalizedDiscordEvent | undefined {
  if (!message.guildId) return undefined;
  const threadId = message.channel?.isThread() ? message.channel.id : undefined;
  const deletedAt = new Date().toISOString();
  return {
    type: "message_delete",
    time: deletedAt,
    guildId: message.guildId,
    channelId: message.channelId,
    ...(threadId ? { threadId } : {}),
    messageId: message.id,
    ...(message.author?.id ? { authorId: message.author.id } : {}),
    payload: { deletedAt },
  };
}

export function normalizeReaction(
  type: "reaction_add" | "reaction_remove",
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser,
): NormalizedDiscordEvent | undefined {
  const message = reaction.message;
  if (!message.guildId) return undefined;
  const threadId = message.channel?.isThread() ? message.channel.id : undefined;
  return {
    type,
    time: new Date().toISOString(),
    guildId: message.guildId,
    channelId: message.channelId,
    ...(threadId ? { threadId } : {}),
    messageId: message.id,
    ...(message.author?.id ? { authorId: message.author.id } : {}),
    payload: {
      userId: user.id,
      emoji: reaction.emoji.toString(),
    },
  };
}

async function resolveReply(
  message: Message<boolean> | PartialMessage,
): Promise<NormalizedDiscordMessage["replyTo"]> {
  const ref = message.reference;
  if (!ref?.messageId) return undefined;
  const cached = message.channel.messages.cache.get(ref.messageId);
  if (!cached) {
    return { messageId: ref.messageId };
  }
  const member = cached.member;
  return {
    messageId: ref.messageId,
    authorId: cached.author.id,
    authorDisplayName: member?.displayName ?? cached.author.globalName ?? cached.author.username,
    contentPreview: cached.cleanContent.slice(0, 300),
  };
}

function normalizeEmbed(embed: Embed): NormalizedDiscordMessage["embeds"][number] {
  return {
    ...(embed.title ? { title: embed.title } : {}),
    ...(embed.description ? { description: embed.description } : {}),
    ...(embed.url ? { url: embed.url } : {}),
    ...(embed.image?.url ? { imageUrl: embed.image.url } : {}),
  };
}

function classifyAttachment(contentType: string | null | undefined, filename: string): AttachmentKind {
  const value = contentType ?? filename.toLowerCase();
  if (value.startsWith("image/") || /\.(png|jpe?g|gif|webp|avif)$/i.test(filename)) return "image";
  if (value.startsWith("video/") || /\.(mp4|mov|webm|mkv)$/i.test(filename)) return "video";
  if (value.startsWith("audio/") || /\.(mp3|wav|ogg|flac)$/i.test(filename)) return "audio";
  if (filename.includes(".")) return "file";
  return "unknown";
}
