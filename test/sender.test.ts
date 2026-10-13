import { AttachmentBuilder } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { sendDiscordMessage } from "../src/discord/sender.js";
import { createDiscordFixture } from "./helpers/discord.js";

const allowedMentions = { parse: [], repliedUser: false };

describe("Discord sender", () => {
  it.each([
    { newerMessageCount: 0, useReply: false },
    { newerMessageCount: 1, useReply: false },
    { newerMessageCount: 2, useReply: true },
    { newerMessageCount: 3, useReply: true },
  ])(
    "selects reply=$useReply with $newerMessageCount newer messages",
    async ({ newerMessageCount, useReply }) => {
      const fixture = await createDiscordFixture({ newerMessageCount });

      const sent = await sendDiscordMessage(fixture.channel, "hello", { replyTo: fixture.message });

      expect(useReply ? fixture.reply : fixture.send).toHaveBeenCalledWith({
        content: "hello",
        allowedMentions,
      });
      expect(useReply ? fixture.send : fixture.reply).not.toHaveBeenCalled();
      expect(sent.content).toBe("hello");
    },
  );

  it("falls back to a normal channel message when newer-message lookup fails", async () => {
    const fixture = await createDiscordFixture({ fetchError: new Error("discord fetch failed") });

    await sendDiscordMessage(fixture.channel, "hello", { replyTo: fixture.message });

    expect(fixture.send).toHaveBeenCalledWith({ content: "hello", allowedMentions });
    expect(fixture.reply).not.toHaveBeenCalled();
  });

  it.each([0, 2])("preserves attachments when there are %i newer messages", async (newerMessageCount) => {
    const fixture = await createDiscordFixture({ newerMessageCount });
    const files = [new AttachmentBuilder(Buffer.from("picture"), { name: "picture.png" })];

    await sendDiscordMessage(fixture.channel, "with attachment", { replyTo: fixture.message, files });

    expect(newerMessageCount >= 2 ? fixture.reply : fixture.send).toHaveBeenCalledWith({
      content: "with attachment",
      files,
      allowedMentions,
    });
  });

  it("rejects a channel that does not support sending messages", async () => {
    const fixture = await createDiscordFixture();
    vi.spyOn(fixture.channel, "isSendable").mockReturnValue(false);

    await expect(sendDiscordMessage(fixture.channel, "hello")).rejects.toThrow(/does not support sending/);
    expect(fixture.send).not.toHaveBeenCalled();
  });
});
