import { describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../src/config.js";
import { DiscordStreamingWriter } from "../src/discord/streaming-writer.js";
import { createDiscordFixture } from "./helpers/discord.js";

const streamingConfig = {
  ...defaultConfig,
  streaming: {
    ...defaultConfig.streaming,
    softLimitChars: 10,
    hardLimitChars: 12,
    editIntervalMs: Number.MAX_SAFE_INTEGER,
  },
};
const allowedMentions = { parse: [], repliedUser: false };

describe("DiscordStreamingWriter", () => {
  it("replies for the first segment and sends continuation segments normally", async () => {
    const fixture = await createDiscordFixture({ newerMessageCount: 2 });
    const writer = new DiscordStreamingWriter(fixture.channel, streamingConfig, fixture.message);

    await writer.append("one two three four");
    await writer.finish();

    expect(fixture.reply).toHaveBeenCalledTimes(1);
    expect(fixture.sentMessages.length).toBeGreaterThan(1);
    expect(fixture.sentMessages.map((message) => message.content).join("")).toBe("one two three four");
    expect(fixture.sentMessages.every((message) => message.content.length <= 12)).toBe(true);
    const payloads = [
      ...fixture.send.mock.calls.map(([payload]) => payload),
      ...fixture.reply.mock.calls.map(([payload]) => payload),
      ...fixture.sentMessages.flatMap((message) =>
        vi.mocked(message.edit).mock.calls.map(([payload]) => payload),
      ),
    ];
    for (const payload of payloads) {
      expect(payload).toMatchObject({ allowedMentions });
    }
  });

  it("sends normally when a previous response already used the reply", async () => {
    const fixture = await createDiscordFixture({ newerMessageCount: 2 });
    const sendState = { firstReplySent: true };
    const writer = new DiscordStreamingWriter(fixture.channel, streamingConfig, fixture.message, sendState);

    await writer.finish("hello");

    expect(fixture.reply).not.toHaveBeenCalled();
    expect(fixture.send).toHaveBeenCalledWith({ content: "hello", allowedMentions });
    expect(fixture.sentMessages.map((message) => message.content)).toEqual(["hello"]);
  });

  it("notifies the caller once the first visible message is sent", async () => {
    const fixture = await createDiscordFixture();
    const onFirstSend = vi.fn();
    const writer = new DiscordStreamingWriter(
      fixture.channel,
      streamingConfig,
      undefined,
      { firstReplySent: false },
      onFirstSend,
    );

    expect(onFirstSend).not.toHaveBeenCalled();
    await writer.finish("hello");
    await writer.finish("hello again");

    expect(onFirstSend).toHaveBeenCalledOnce();
    expect(fixture.sentMessages.map((message) => message.content)).toEqual(["hello again"]);
  });
});
