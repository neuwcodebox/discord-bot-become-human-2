import {
  type APIMessage,
  type APIUser,
  ChannelType,
  Client,
  ClientUser,
  type DMChannel,
  type Message,
  MessagePayload,
  MessageType,
  Routes,
} from "discord.js";
import { onTestFinished, vi } from "vitest";

const botId = "100000000000000001";
const authorId = "100000000000000002";
const channelId = "100000000000000003";
const sourceMessageId = "100000000000000004";

function userData(id: string): APIUser {
  return {
    id,
    username: id === botId ? "bot" : "member",
    global_name: null,
    discriminator: "0",
    avatar: null,
    bot: id === botId,
  };
}

class FixtureClientUser extends ClientUser {
  constructor(client: Client<true>) {
    super(client, userData(botId));
  }
}

type MessageInput = { id?: string; authorId?: string; content?: string };

function messageData(input: MessageInput & { id: string }): APIMessage {
  return {
    id: input.id,
    channel_id: channelId,
    author: userData(input.authorId ?? authorId),
    content: input.content ?? "source message",
    timestamp: "2026-01-01T00:00:00.000Z",
    edited_timestamp: null,
    tts: false,
    mention_everyone: false,
    mentions: [],
    mention_roles: [],
    attachments: [],
    embeds: [],
    pinned: false,
    type: MessageType.Default,
    components: [],
  };
}

function messageContent(options: string | MessagePayload | { content?: string | null }): string {
  const payload = options instanceof MessagePayload ? options.options : options;
  return typeof payload === "string" ? payload : (payload.content ?? "");
}

function isDirectMessage(message: Message<boolean>): message is Message<false> & { channel: DMChannel } {
  return message.guildId === null && message.channel.type === ChannelType.DM;
}

export async function createDiscordFixture(
  input: { newerMessageCount?: number; fetchError?: Error; guildId?: string } = {},
) {
  const client = new Client<true>({ intents: [] });
  client.user = new FixtureClientUser(client);
  client.users.cache.set(botId, client.user);
  onTestFinished(() => client.destroy());

  const rawMessages = new Map<string, APIMessage>();
  let nextMessageId = 100000000000000100n;
  const sentMessages: Message<boolean>[] = [];
  vi.spyOn(client.rest, "get").mockImplementation(async (route) => {
    if (route === Routes.channel(channelId)) {
      return { id: channelId, type: ChannelType.DM, recipients: [userData(authorId)] };
    }
    if (route === Routes.channelMessages(channelId)) {
      if (input.fetchError) throw input.fetchError;
      return Array.from({ length: input.newerMessageCount ?? 0 }, (_, index) =>
        messageData({ id: String(100000000000000010n + BigInt(index)) }),
      );
    }
    const id = route.split("/").at(-1);
    const data = id ? rawMessages.get(id) : undefined;
    if (data) return data;
    throw new Error(`Unexpected Discord GET: ${route}`);
  });
  vi.spyOn(client.rest, "put").mockResolvedValue(null);
  for (const method of ["post", "patch", "delete"] as const) {
    vi.spyOn(client.rest, method).mockRejectedValue(new Error(`Unexpected Discord REST ${method}`));
  }

  const fetchedChannel = await client.channels.fetch(channelId);
  if (!fetchedChannel || fetchedChannel.type !== ChannelType.DM) {
    throw new Error("Expected a fixture DM channel.");
  }
  const channel = fetchedChannel;

  async function createMessage(messageInput: MessageInput = {}) {
    const id = messageInput.id ?? String(nextMessageId++);
    rawMessages.set(id, messageData({ ...messageInput, id }));
    const message = await channel.messages.fetch(id);
    if (!isDirectMessage(message)) throw new Error("Expected a fixture DM message.");
    vi.spyOn(message, "edit").mockImplementation(async (options) => {
      message.content = messageContent(options);
      return message;
    });
    vi.spyOn(message, "delete").mockResolvedValue(message);
    vi.spyOn(message, "react");
    return message;
  }

  const send = vi.spyOn(channel, "send").mockImplementation(async (options) => {
    const message = await createMessage({ authorId: botId, content: messageContent(options) });
    sentMessages.push(message);
    return message;
  });
  const sendTyping = vi.spyOn(channel, "sendTyping").mockResolvedValue(undefined);
  const message: Message<boolean> = await createMessage({ id: sourceMessageId });
  if (input.guildId) message.guildId = input.guildId;
  const reply = vi.spyOn(message, "reply").mockImplementation(async (options) => {
    const replyMessage = await createMessage({ authorId: botId, content: messageContent(options) });
    sentMessages.push(replyMessage);
    return replyMessage;
  });

  return { client, channel, message, send, reply, sendTyping, sentMessages, createMessage };
}
