import type { NormalizedDiscordEvent, NormalizedDiscordMessage } from "../../src/types.js";

export function createMessage(
  id = "m1",
  overrides: Partial<NormalizedDiscordMessage> = {},
): NormalizedDiscordMessage {
  return {
    id,
    guildId: "g1",
    channelId: "c1",
    author: { id: "u1", username: "User", displayName: "User", isBot: false },
    content: "latest message",
    cleanContent: "latest message",
    createdAt: "2026-05-11T12:00:03.000Z",
    mentions: [],
    attachments: [],
    embeds: [],
    reactions: [],
    links: [],
    ...overrides,
  };
}

export function createMessageEvent(
  message: NormalizedDiscordMessage,
): Extract<NormalizedDiscordEvent, { type: "message_create" }> {
  return {
    type: "message_create",
    time: message.createdAt,
    guildId: message.guildId,
    channelId: message.channelId,
    ...(message.threadId !== undefined ? { threadId: message.threadId } : {}),
    messageId: message.id,
    authorId: message.author.id,
    payload: message,
  };
}
