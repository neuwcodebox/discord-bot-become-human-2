import { Collection, type Message, type MessageMentionOptions, type TextBasedChannel } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { createDiscordActionRuntimeFromMessage } from "../src/tools/discord-actions.js";

type SendPayload = { content: string; allowedMentions: MessageMentionOptions };
type FetchOptions = { after: string; limit: number };

function createFixture(id = "source-message") {
  const sentMessage = (msgId: string) => ({ id: msgId }) as unknown as Message<boolean>;
  let sendCount = 0;
  const fetch = vi.fn(
    async (_opts: FetchOptions): Promise<Collection<string, Message<boolean>>> => new Collection(),
  );
  const send = vi.fn(
    async (_opts: SendPayload): Promise<Message<boolean>> => sentMessage(`sent-${++sendCount}`),
  );
  const reply = vi.fn(async (_opts: SendPayload): Promise<Message<boolean>> => sentMessage("replied"));
  const channel = { send, messages: { fetch } } as unknown as TextBasedChannel;
  const message = { id, channel, reply } as unknown as Message<boolean>;
  return { message, channel, send, reply, fetch };
}

describe("DiscordActionRuntime.sendMessage", () => {
  it("passes replyTo on the first call when firstReplySent is false", async () => {
    const { message, fetch } = createFixture();
    const runtime = createDiscordActionRuntimeFromMessage(message, { guildId: "g", workspaceRoot: "/w" });

    await runtime.sendMessage("hello");

    expect(fetch).toHaveBeenCalledWith({ after: "source-message", limit: 2 });
  });

  it("does not pass replyTo on the second call", async () => {
    const { message, fetch } = createFixture();
    const runtime = createDiscordActionRuntimeFromMessage(message, { guildId: "g", workspaceRoot: "/w" });

    await runtime.sendMessage("first");
    fetch.mockClear();
    await runtime.sendMessage("second");

    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not pass replyTo when firstReplySent is already true", async () => {
    const { message, fetch } = createFixture();
    const sendState = { firstReplySent: true };
    const runtime = createDiscordActionRuntimeFromMessage(
      message,
      { guildId: "g", workspaceRoot: "/w" },
      sendState,
    );

    await runtime.sendMessage("hello");

    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns the messageId of the sent message", async () => {
    const { message } = createFixture();
    const sendState = { firstReplySent: true };
    const runtime = createDiscordActionRuntimeFromMessage(
      message,
      { guildId: "g", workspaceRoot: "/w" },
      sendState,
    );

    const result = await runtime.sendMessage("hello");

    expect(result).toHaveProperty("messageId");
    expect(typeof result.messageId).toBe("string");
    expect(result.messageId.length).toBeGreaterThan(0);
  });

  it("sends multiple chunks for content exceeding hardLimit", async () => {
    const { message, send } = createFixture();
    const sendState = { firstReplySent: true };
    const limits = { softLimitChars: 10, hardLimitChars: 12 };
    const runtime = createDiscordActionRuntimeFromMessage(
      message,
      { guildId: "g", workspaceRoot: "/w" },
      sendState,
      limits,
    );

    await runtime.sendMessage("one two three four");

    expect(send.mock.calls.length).toBeGreaterThan(1);
    for (const [payload] of send.mock.calls as [SendPayload][]) {
      expect(payload.content.length).toBeLessThanOrEqual(12);
    }
  });

  it("returns the last chunk's messageId when content is split", async () => {
    const { message, send } = createFixture();
    const sendState = { firstReplySent: true };
    const limits = { softLimitChars: 10, hardLimitChars: 12 };
    const runtime = createDiscordActionRuntimeFromMessage(
      message,
      { guildId: "g", workspaceRoot: "/w" },
      sendState,
      limits,
    );

    const result = await runtime.sendMessage("one two three four");
    const lastCallResult = await (send.mock.results.at(-1)?.value as Promise<Message<boolean>>);

    expect(result.messageId).toBe(lastCallResult.id);
  });
});
