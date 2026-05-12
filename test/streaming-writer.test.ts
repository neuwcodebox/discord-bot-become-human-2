import { Collection, type Message, type MessageMentionOptions, type TextBasedChannel } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../src/config.js";
import { safeAllowedMentions } from "../src/discord/sender.js";
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
  it("applies reply policy only to the first placeholder and sends continuation segments normally", async () => {
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

    expect(fetch).toHaveBeenCalledWith({ after: "target-message", limit: 2 });
    expect(reply).toHaveBeenCalledWith({
      content: defaultConfig.streaming.initialPlaceholder,
      allowedMentions: safeAllowedMentions,
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0].allowedMentions).toEqual(safeAllowedMentions);
    expect(placeholder.edit).toHaveBeenCalled();
    expect(continuation.edit).not.toHaveBeenCalled();
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
