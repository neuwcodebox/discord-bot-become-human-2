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
  it("bounds code-fence overhead and makes progress with small segment limits", async () => {
    const fixture = await createDiscordFixture();
    const send = fixture.send.getMockImplementation();
    if (!send) throw new Error("Missing fixture send implementation.");
    fixture.send.mockImplementation(async (...args) => {
      if (fixture.sentMessages.length >= 30) throw new Error("Segment loop made no progress.");
      return send(...args);
    });
    const writer = new DiscordStreamingWriter(fixture.channel, streamingConfig);
    await writer.finish("```typescript\nhello world hello world\n```");
    expect(fixture.sentMessages.every((message) => message.content.length <= 12)).toBe(true);
  });

  it("makes progress when a fence language is longer than the segment limit", async () => {
    const fixture = await createDiscordFixture();
    const send = fixture.send.getMockImplementation();
    if (!send) throw new Error("Missing fixture send implementation.");
    fixture.send.mockImplementation(async (...args) => {
      if (fixture.sentMessages.length >= 5) throw new Error("Segment loop made no progress.");
      return send(...args);
    });
    const writer = new DiscordStreamingWriter(fixture.channel, defaultConfig);
    await writer.finish(`\`\`\`${"a".repeat(2100)}\n${"x".repeat(100)}`);
    expect(fixture.sentMessages.length).toBeLessThanOrEqual(3);
  });

  it("does not duplicate previous segments when finishing with the full generated text", async () => {
    const fixture = await createDiscordFixture();
    const writer = new DiscordStreamingWriter(fixture.channel, streamingConfig, fixture.message);
    await writer.append("one two three four five six seven eight");
    await writer.finish("one two three four five six seven eight");
    expect(fixture.sentMessages.map((message) => message.content).join("")).toBe(
      "one two three four five six seven eight",
    );
    expect(fixture.sentMessages.every((message) => message.content.length <= 12)).toBe(true);
  });

  it("keeps successive assistant turns separate when a correction is delivered", async () => {
    const fixture = await createDiscordFixture();
    const writer = new DiscordStreamingWriter(fixture.channel, defaultConfig, fixture.message);
    await writer.startMessage();
    await writer.append("서울 기준 ");
    await writer.startMessage();
    await writer.append("부산 기준 답변");
    await writer.finish("부산 기준 답변");
    expect(fixture.sentMessages.map((message) => message.content)).toEqual(["서울 기준 ", "부산 기준 답변"]);
  });

  it("stops sending or editing after cancellation, including buffered writes", async () => {
    const fixture = await createDiscordFixture();
    const controller = new AbortController();
    const writer = new DiscordStreamingWriter(
      fixture.channel,
      streamingConfig,
      fixture.message,
      { firstReplySent: false },
      undefined,
      controller.signal,
    );
    await writer.append("buffered");
    controller.abort();
    await expect(writer.finish("late")).rejects.toThrow();
    await expect(writer.append("later")).rejects.toThrow();
    expect(fixture.sentMessages).toEqual([]);
  });

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
