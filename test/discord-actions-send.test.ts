import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDiscordActionRuntimeFromMessage } from "../src/tools/discord-actions.js";
import { createDiscordFixture } from "./helpers/discord.js";
import { createTestWorkspace } from "./helpers/workspace.js";

const allowedMentions = { parse: [], repliedUser: false };

async function actionFixture({
  newerMessageCount = 2,
  sendState = { firstReplySent: false },
  workspaceRoot = "/unused",
  limits = { softLimitChars: 1800, hardLimitChars: 1950 },
} = {}) {
  const fixture = await createDiscordFixture({ newerMessageCount });
  const runtime = createDiscordActionRuntimeFromMessage(
    fixture.message,
    { guildId: "g", workspaceRoot },
    sendState,
    limits,
  );
  return { ...fixture, runtime };
}

describe("Discord actions", () => {
  it("replies to the source once and sends subsequent messages normally", async () => {
    const fixture = await actionFixture();

    await fixture.runtime.sendMessage("first");
    await fixture.runtime.sendMessage("second");

    expect(fixture.reply).toHaveBeenCalledWith({ content: "first", allowedMentions });
    expect(fixture.send).toHaveBeenCalledWith({ content: "second", allowedMentions });
    expect(fixture.sentMessages.map((message) => message.content)).toEqual(["first", "second"]);
  });

  it("sends normally when an earlier response already used the reply", async () => {
    const fixture = await actionFixture({ sendState: { firstReplySent: true } });

    const result = await fixture.runtime.sendMessage("hello");

    expect(fixture.reply).not.toHaveBeenCalled();
    expect(fixture.send).toHaveBeenCalledWith({ content: "hello", allowedMentions });
    expect(result.messageId).toBe(fixture.sentMessages.map((message) => message.id).at(-1));
  });

  it("keeps split content within the message limit and returns the last message ID", async () => {
    const fixture = await actionFixture({ limits: { softLimitChars: 10, hardLimitChars: 12 } });

    const result = await fixture.runtime.sendMessage("one two three four");
    const chunks = fixture.sentMessages.map((message) => message.content);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 12)).toBe(true);
    expect(chunks.join(" ")).toBe("one two three four");
    expect(fixture.reply).toHaveBeenCalledTimes(1);
    expect(result.messageId).toBe(fixture.sentMessages.map((message) => message.id).at(-1));
  });

  it("sends a workspace file without requiring text", async () => {
    const workspaceRoot = await createTestWorkspace();
    const contents = Buffer.from("attachment contents");
    await writeFile(join(workspaceRoot, "note.txt"), contents);
    const fixture = await actionFixture({ workspaceRoot, sendState: { firstReplySent: true } });

    const result = await fixture.runtime.sendMessage(undefined, ["note.txt"]);

    expect(fixture.send).toHaveBeenCalledWith({
      content: "",
      files: [expect.objectContaining({ name: "note.txt", attachment: contents })],
      allowedMentions,
    });
    expect(result.messageId).toBe(fixture.sentMessages.map((message) => message.id).at(-1));
  });

  it("rejects attachment paths outside the current workspace", async () => {
    const workspaceRoot = await createTestWorkspace();
    const outsideRoot = await createTestWorkspace();
    const outsideFile = join(outsideRoot, "private.txt");
    await writeFile(outsideFile, "private contents");
    const fixture = await actionFixture({ workspaceRoot });

    await expect(fixture.runtime.sendMessage(undefined, [outsideFile])).rejects.toThrow(
      /escapes guild workspace/,
    );
    expect(fixture.sentMessages).toEqual([]);
  });

  it("rejects a message with neither text nor files", async () => {
    const fixture = await actionFixture();

    await expect(fixture.runtime.sendMessage(undefined, [])).rejects.toThrow(/content or files/);
    expect(fixture.sentMessages).toEqual([]);
  });

  it("allows editing and deleting bot-owned messages", async () => {
    const fixture = await actionFixture();
    const owned = await fixture.createMessage({ authorId: fixture.client.user.id, content: "before" });

    await fixture.runtime.editOwn(owned.id, "after");
    await fixture.runtime.deleteOwn(owned.id);

    expect(owned.content).toBe("after");
    expect(owned.edit).toHaveBeenCalledWith({ content: "after", allowedMentions });
    expect(owned.delete).toHaveBeenCalledOnce();
  });

  it.each(["editOwn", "deleteOwn"] as const)("rejects %s for another user's message", async (action) => {
    const fixture = await actionFixture();
    const attempt =
      action === "editOwn"
        ? fixture.runtime.editOwn(fixture.message.id, "changed")
        : fixture.runtime.deleteOwn(fixture.message.id);

    await expect(attempt).rejects.toThrow(/only bot-owned messages/);
    expect(fixture.message.content).toBe("source message");
    expect(fixture.message.edit).not.toHaveBeenCalled();
    expect(fixture.message.delete).not.toHaveBeenCalled();
  });
});
