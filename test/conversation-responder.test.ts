import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentUnavailableError } from "../src/agent/availability.js";
import type { AgentRunner } from "../src/agent/runner.js";
import { defaultConfig } from "../src/config.js";
import { ConversationResponder } from "../src/conversation/responder.js";
import { AttachmentCache } from "../src/discord/attachment-cache.js";
import type {
  AppConfig,
  BotIdentity,
  EngagementDecision,
  GuildWorkspace,
  StayDecision,
} from "../src/types.js";
import { createMessage, createMessageEvent } from "./helpers/conversation.js";
import { createDiscordFixture } from "./helpers/discord.js";
import { createTestWorkspace } from "./helpers/workspace.js";

afterEach(() => vi.useRealTimers());

describe("conversation responder", () => {
  it("does not retry or send a fallback when the subscription gate pauses a reply", async () => {
    const run = vi.fn<AgentRunner["run"]>().mockRejectedValue(new AgentUnavailableError());
    const fixture = await createFixture({ run });
    await fixture.responder.reply(fixture.task, fixture.events, fixture.workspace, fixture.discord.message);
    expect(run).toHaveBeenCalledOnce();
    expect(fixture.discord.sentMessages).toEqual([]);
  });

  it("keeps accepted corrections in the context when retrying an empty response", async () => {
    const run = vi
      .fn<AgentRunner["run"]>()
      .mockImplementationOnce(async (request) => {
        request.onControlReady?.({ steer: () => true });
        return { text: "" };
      })
      .mockResolvedValue({ text: "부산 기준 답변" });
    const fixture = await createFixture({ run });
    await fixture.responder.reply(fixture.task, fixture.events, fixture.workspace, fixture.discord.message, {
      onControlReady: (control) => {
        control.steer("관찰된 정정: 부산 기준으로");
      },
    });
    expect(run.mock.calls[1]?.[0].messages).toContainEqual({
      role: "user",
      content: "관찰된 정정: 부산 기준으로",
    });
    expect(fixture.discord.sentMessages.map((message) => message.content)).toEqual(["부산 기준 답변"]);
  });

  it.each([false, true])(
    "does not retry or publish a reply cancelled during generation, streaming=%s",
    async (streaming) => {
      const controller = new AbortController();
      const run = vi.fn<AgentRunner["run"]>(async (request) => {
        controller.abort();
        await expect(request.onTextDelta?.("late output")).rejects.toThrow();
        return { text: "" };
      });
      const fixture = await createFixture({ run }, { streaming });
      await fixture.responder.reply(
        fixture.task,
        fixture.events,
        fixture.workspace,
        fixture.discord.message,
        { signal: controller.signal },
      );
      expect(run).toHaveBeenCalledOnce();
      expect(fixture.discord.sentMessages).toEqual([]);
    },
  );

  it.each([false, true])("sends the generated reply with streaming=%s", async (streaming) => {
    const run = vi.fn<AgentRunner["run"]>(async (request) => {
      await request.onTextDelta?.("hello");
      return { text: "hello" };
    });
    const fixture = await createFixture({ run }, { streaming });

    const messageId = await fixture.responder.reply(
      fixture.task,
      fixture.events,
      fixture.workspace,
      fixture.discord.message,
    );

    expect(fixture.discord.sentMessages.map((message) => message.content)).toEqual(["hello"]);
    expect(messageId).toBe(fixture.discord.sentMessages[0]?.id);
  });

  it.each([false, true])(
    "recovers an empty reply without granting tools to the retry, streaming=%s",
    async (streaming) => {
      const run = vi
        .fn<AgentRunner["run"]>()
        .mockResolvedValueOnce({ text: " " })
        .mockImplementation(async (request) => {
          await request.onTextDelta?.("recovered reply");
          return { text: "recovered reply" };
        });
      const fixture = await createFixture({ run }, { streaming });

      await fixture.responder.reply(fixture.task, fixture.events, fixture.workspace, fixture.discord.message);

      expect(fixture.discord.sentMessages.map((message) => message.content)).toEqual(["recovered reply"]);
      expect(run).toHaveBeenCalledTimes(2);
      expect(run.mock.calls[1]?.[0].tools).toBeUndefined();
    },
  );

  it("sends a fallback when both reply attempts are empty", async () => {
    const run = vi.fn<AgentRunner["run"]>().mockResolvedValue({ text: "" });
    const fixture = await createFixture({ run });

    await fixture.responder.reply(fixture.task, fixture.events, fixture.workspace, fixture.discord.message);

    expect(fixture.discord.sentMessages.map((message) => message.content)).toEqual([
      "방금 답변을 제대로 만들지 못했어요.",
    ]);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("flushes buffered response text before an additional tool message", async () => {
    const run = vi.fn<AgentRunner["run"]>(async (request) => {
      await request.onTextDelta?.("main reply");
      const send = request.tools?.find((tool) => tool.name === "discord_send_message");
      if (!send) throw new Error("Message tool was not provided.");
      await send.execute("additional-message", { content: "additional message" });
      return { text: "main reply" };
    });
    const fixture = await createFixture(
      { run },
      {
        streaming: true,
        editIntervalMs: Number.MAX_SAFE_INTEGER,
        newerMessageCount: 2,
      },
    );

    await fixture.responder.reply(fixture.task, fixture.events, fixture.workspace, fixture.discord.message);

    expect(fixture.discord.sentMessages.map((message) => message.content)).toEqual([
      "main reply",
      "additional message",
    ]);
    expect(fixture.discord.reply).toHaveBeenCalledTimes(1);
  });

  it("uses the first reply for an additional tool message when response streaming is disabled", async () => {
    const run = vi.fn<AgentRunner["run"]>(async (request) => {
      const send = request.tools?.find((tool) => tool.name === "discord_send_message");
      if (!send) throw new Error("Message tool was not provided.");
      await send.execute("additional-message", { content: "additional message" });
      return { text: "main reply" };
    });
    const fixture = await createFixture({ run }, { newerMessageCount: 2 });

    await fixture.responder.reply(fixture.task, fixture.events, fixture.workspace, fixture.discord.message);

    expect(fixture.discord.sentMessages.map((message) => message.content)).toEqual([
      "additional message",
      "main reply",
    ]);
    expect(fixture.discord.reply).toHaveBeenCalledTimes(1);
  });

  it("stops sending typing notifications when preparing the response fails", async () => {
    const run = vi.fn<AgentRunner["run"]>();
    const fixture = await createFixture({ run });
    const responder = new ConversationResponder(
      fixture.config,
      join(fixture.workspace.workspaceRoot, "missing-instructions.md"),
      { run },
      fixture.botIdentity,
      new AttachmentCache(),
    );
    vi.useFakeTimers();

    await expect(
      responder.reply(fixture.task, fixture.events, fixture.workspace, fixture.discord.message),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await vi.advanceTimersByTimeAsync(24_000);

    expect(fixture.discord.sendTyping).toHaveBeenCalledTimes(1);
    expect(fixture.discord.sentMessages).toEqual([]);
  });

  it("allows only an emoji reaction and sends no text for a reaction action", async () => {
    let terminated = false;
    const run = vi.fn<AgentRunner["run"]>(async (request) => {
      const tool = request.tools?.find((candidate) => candidate.name === "discord_react");
      if (!tool) throw new Error("Reaction tool was not provided.");
      const result = await tool.execute("reaction-call", {
        messageId: task.targetMessageIds[0],
        emoji: "👍",
      });
      terminated = result.terminate === true;
      return { text: "" };
    });
    const fixture = await createFixture({ run });
    const task: StayDecision = {
      stayEngaged: false,
      action: "react",
      confidence: 1,
      reason: "acknowledge",
      attention: "directed_at_bot",
      targetMessageIds: [fixture.discord.message.id],
      replyPriority: "none",
    };

    await fixture.responder.react(
      task,
      fixture.events,
      fixture.workspace,
      fixture.discord.message,
      fixture.currentMessage,
    );

    expect(run.mock.calls[0]?.[0].tools?.map((tool) => tool.name)).toEqual(["discord_react"]);
    expect(fixture.discord.message.react).toHaveBeenCalledWith("👍");
    expect(fixture.discord.sentMessages).toEqual([]);
    expect(terminated).toBe(true);
  });

  it("keeps reaction failures out of Discord messages", async () => {
    const run = vi.fn<AgentRunner["run"]>().mockRejectedValue(new Error("provider unavailable"));
    const fixture = await createFixture({ run });
    const task: StayDecision = {
      stayEngaged: true,
      action: "react",
      confidence: 1,
      reason: "acknowledge",
      attention: "directed_at_bot",
      targetMessageIds: [],
      replyPriority: "none",
    };

    await expect(
      fixture.responder.react(
        task,
        fixture.events,
        fixture.workspace,
        fixture.discord.message,
        fixture.currentMessage,
      ),
    ).resolves.toBeUndefined();
    expect(fixture.discord.sentMessages).toEqual([]);
  });
});

async function createFixture(
  runner: AgentRunner,
  options: { streaming?: boolean; editIntervalMs?: number; newerMessageCount?: number } = {},
) {
  const root = await createTestWorkspace("dbh2-responder-");
  const agentsPath = join(root, "AGENTS.md");
  await writeFile(agentsPath, "runtime instructions", "utf8");
  const discord = await createDiscordFixture({ newerMessageCount: options.newerMessageCount ?? 0 });
  const config: AppConfig = {
    ...defaultConfig,
    streaming: {
      ...defaultConfig.streaming,
      enabled: options.streaming ?? false,
      editIntervalMs: options.editIntervalMs ?? defaultConfig.streaming.editIntervalMs,
    },
  };
  const workspace: GuildWorkspace = { guildId: "g1", guildRoot: root, workspaceRoot: root };
  const botIdentity: BotIdentity = {
    userId: discord.client.user.id,
    username: "bot",
    globalName: null,
    tag: "bot",
    mention: `<@${discord.client.user.id}>`,
    names: ["bot"],
  };
  const currentMessage = createMessage(discord.message.id, { channelId: discord.channel.id });
  const task: EngagementDecision = {
    engage: true,
    confidence: 1,
    reason: "direct question",
    targetMessageIds: [currentMessage.id],
    expectedRole: "answer_question",
  };
  return {
    config,
    botIdentity,
    workspace,
    discord,
    task,
    currentMessage,
    events: [createMessageEvent(currentMessage)],
    responder: new ConversationResponder(config, agentsPath, runner, botIdentity, new AttachmentCache()),
  };
}
