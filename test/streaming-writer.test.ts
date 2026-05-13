import { Collection, type Message, type MessageMentionOptions, type TextBasedChannel } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../src/config.js";
import { DiscordStreamingWriter } from "../src/discord/streaming-writer.js";
import type { AppConfig } from "../src/types.js";

type SendPayload = {
  content: string;
  allowedMentions: MessageMentionOptions;
};

type FetchOptions = {
  after: string;
  limit: number;
};

describe("DiscordStreamingWriter", () => {
  it("applies reply policy only to the first real message and sends continuation segments normally", async () => {
    const placeholder = createEditableMessage("placeholder-message");
    const continuation = createEditableMessage("continuation-message");
    const fetch = vi.fn(async (_options: FetchOptions): Promise<Collection<string, Message<boolean>>> => {
      return new Collection([
        ["newer-1", { id: "newer-1" } as unknown as Message<boolean>],
        ["newer-2", { id: "newer-2" } as unknown as Message<boolean>],
      ]);
    });
    const send = vi.fn(async (_options: SendPayload): Promise<Message<boolean>> => continuation.message);
    const channel = {
      send,
      messages: {
        fetch,
      },
    } as unknown as TextBasedChannel;
    const reply = vi.fn(async (_options: SendPayload): Promise<Message<boolean>> => placeholder.message);
    const targetMessage = {
      id: "target-message",
      channel,
      reply,
    } as unknown as Message<boolean>;
    const writer = new DiscordStreamingWriter(channel, streamingConfig(), targetMessage);

    await writer.append("one two three four");

    // Reply policy check runs for the first real message
    expect(fetch).toHaveBeenCalledWith({ after: "target-message", limit: 2 });
    // First message uses reply (2+ newer messages in mock)
    expect(reply).toHaveBeenCalledTimes(1);
    // Continuation segment uses send (no reply policy)
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0].allowedMentions).toBeDefined();
    // First message was edited (by rollSegment finalizing it)
    expect(placeholder.edit).toHaveBeenCalled();
    expect(continuation.edit).not.toHaveBeenCalled();
  });

  it("does not use reply when sendState.firstReplySent is already true", async () => {
    const firstMessage = createEditableMessage("first-message");
    const fetch = vi.fn(async (_options: FetchOptions): Promise<Collection<string, Message<boolean>>> => {
      return new Collection([
        ["newer-1", { id: "newer-1" } as unknown as Message<boolean>],
        ["newer-2", { id: "newer-2" } as unknown as Message<boolean>],
      ]);
    });
    const send = vi.fn(async (_options: SendPayload): Promise<Message<boolean>> => firstMessage.message);
    const channel = { send, messages: { fetch } } as unknown as TextBasedChannel;
    const reply = vi.fn(async (_options: SendPayload): Promise<Message<boolean>> => firstMessage.message);
    const targetMessage = { id: "target-message", channel, reply } as unknown as Message<boolean>;
    const sendState = { firstReplySent: true };
    const writer = new DiscordStreamingWriter(channel, streamingConfig(), targetMessage, sendState);

    await writer.finish("hello");

    expect(fetch).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalled();
  });

  it("calls onFirstSend when the first real message is sent", async () => {
    const msg = createEditableMessage("msg");
    const send = vi.fn(async (_options: SendPayload): Promise<Message<boolean>> => msg.message);
    const fetch = vi.fn(async () => new Collection<string, Message<boolean>>());
    const channel = { send, messages: { fetch } } as unknown as TextBasedChannel;
    const onFirstSend = vi.fn();
    const writer = new DiscordStreamingWriter(
      channel,
      streamingConfig(),
      undefined,
      { firstReplySent: false },
      onFirstSend,
    );

    expect(onFirstSend).not.toHaveBeenCalled();
    await writer.finish("hello");
    expect(onFirstSend).toHaveBeenCalledTimes(1);
  });
});

function streamingConfig(): AppConfig {
  return {
    ...defaultConfig,
    streaming: {
      ...defaultConfig.streaming,
      softLimitChars: 10,
      hardLimitChars: 12,
      editIntervalMs: Number.MAX_SAFE_INTEGER,
    },
  };
}

function createEditableMessage(id: string) {
  const partial = {
    id,
    editable: true,
  };
  const message = partial as unknown as Message<boolean>;
  const edit = vi.fn(async (_options: SendPayload): Promise<Message<boolean>> => message);

  return {
    message: {
      ...partial,
      edit,
    } as unknown as Message<boolean>,
    edit,
  };
}
