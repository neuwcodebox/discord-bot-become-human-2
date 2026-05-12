import { Collection, type Message, type MessageMentionOptions, type TextBasedChannel } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { safeAllowedMentions, sendDiscordMessage } from "../src/discord/sender.js";

type SendPayload = {
  content: string;
  allowedMentions: MessageMentionOptions;
};

type FetchOptions = {
  after: string;
  limit: number;
};

describe("Discord sender", () => {
  it("sends a normal channel message when the target has no newer messages", async () => {
    const fixture = createMessageFixture({ newerMessageCount: 0 });

    await sendDiscordMessage(fixture.channel, "hello", { replyTo: fixture.targetMessage });

    expect(fixture.fetch).toHaveBeenCalledWith({ after: "target-message", limit: 2 });
    expect(fixture.send).toHaveBeenCalledWith({ content: "hello", allowedMentions: safeAllowedMentions });
    expect(fixture.reply).not.toHaveBeenCalled();
  });

  it("sends a normal channel message when the target has one newer message", async () => {
    const fixture = createMessageFixture({ newerMessageCount: 1 });

    await sendDiscordMessage(fixture.channel, "hello", { replyTo: fixture.targetMessage });

    expect(fixture.send).toHaveBeenCalledWith({ content: "hello", allowedMentions: safeAllowedMentions });
    expect(fixture.reply).not.toHaveBeenCalled();
  });

  it("uses Discord reply when the target has at least two newer messages", async () => {
    const fixture = createMessageFixture({ newerMessageCount: 2 });

    await sendDiscordMessage(fixture.channel, "hello", { replyTo: fixture.targetMessage });

    expect(fixture.reply).toHaveBeenCalledWith({ content: "hello", allowedMentions: safeAllowedMentions });
    expect(fixture.send).not.toHaveBeenCalled();
  });

  it("falls back to a normal channel message when newer-message lookup fails", async () => {
    const fixture = createMessageFixture({ fetchError: new Error("discord fetch failed") });

    await sendDiscordMessage(fixture.channel, "hello", { replyTo: fixture.targetMessage });

    expect(fixture.send).toHaveBeenCalledWith({ content: "hello", allowedMentions: safeAllowedMentions });
    expect(fixture.reply).not.toHaveBeenCalled();
  });
});

function createMessageFixture(input: { newerMessageCount?: number; fetchError?: Error }) {
  const sentMessage = { id: "sent-message" } as unknown as Message<boolean>;
  const fetch = vi.fn(async (_options: FetchOptions): Promise<Collection<string, Message<boolean>>> => {
    if (input.fetchError) throw input.fetchError;
    return messageCollection(input.newerMessageCount ?? 0);
  });
  const send = vi.fn(async (_options: SendPayload): Promise<Message<boolean>> => sentMessage);
  const reply = vi.fn(async (_options: SendPayload): Promise<Message<boolean>> => sentMessage);
  const channel = {
    send,
    messages: {
      fetch,
    },
  } as unknown as TextBasedChannel;
  const targetMessage = {
    id: "target-message",
    channel,
    reply,
  } as unknown as Message<boolean>;

  return { channel, targetMessage, fetch, send, reply };
}

function messageCollection(count: number): Collection<string, Message<boolean>> {
  return new Collection(
    Array.from({ length: count }, (_, index) => [
      `newer-message-${index}`,
      { id: `newer-message-${index}` } as unknown as Message<boolean>,
    ]),
  );
}
