import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentRunner } from "../src/agent/runner.js";
import { defaultConfig } from "../src/config.js";
import { ConversationOrchestrator } from "../src/conversation/orchestrator.js";
import { EventLog } from "../src/memory/event-log.js";
import type { AppConfig, BotIdentity, GuildWorkspace } from "../src/types.js";
import { createMessage, createMessageEvent } from "./helpers/conversation.js";
import { createDiscordFixture } from "./helpers/discord.js";
import { createTestWorkspace } from "./helpers/workspace.js";

const botIdentity: BotIdentity = {
  userId: "bot-1",
  username: "test-bot",
  globalName: "Test Bot",
  tag: "test-bot#0001",
  mention: "<@bot-1>",
  names: ["Test Bot", "test-bot", "test-bot#0001"],
};

const declinedDecision = JSON.stringify({
  engage: false,
  confidence: 0.1,
  reason: "background chatter",
  targetMessageIds: [],
  expectedRole: "other",
});

describe("conversation orchestrator", () => {
  it("rate limits ambient decisions even when engagement is declined", async () => {
    const run = vi.fn<AgentRunner["run"]>().mockResolvedValue({ text: declinedDecision });
    const { orchestrator, workspace, log } = await createFixture({ run });

    for (const id of ["m1", "m2"]) {
      const event = createMessageEvent(createMessage(id));
      await log.append(event);
      await orchestrator.onMessage(event, workspace);
    }

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("continues processing messages after a decision run fails", async () => {
    const run = vi
      .fn<AgentRunner["run"]>()
      .mockRejectedValueOnce(new Error("provider unavailable"))
      .mockResolvedValue({ text: declinedDecision });
    const { orchestrator, workspace, log } = await createFixture({ run }, 0);

    for (const id of ["m1", "m2"]) {
      const event = createMessageEvent(createMessage(id));
      await log.append(event);
      await orchestrator.onMessage(event, workspace);
    }

    expect(run).toHaveBeenCalledTimes(2);
  });

  it("passes the successful reply and reset human count to the next stay decision", async () => {
    const discord = await createDiscordFixture();
    const user = discord.client.user;
    const identity: BotIdentity = {
      userId: user.id,
      username: user.username,
      globalName: user.globalName,
      tag: user.tag,
      mention: user.toString(),
      names: [user.username],
    };
    const run = vi
      .fn<AgentRunner["run"]>()
      .mockResolvedValueOnce({ text: "first reply" })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          stayEngaged: true,
          action: "silent_track",
          confidence: 1,
          reason: "keep listening",
          attention: "background",
          targetMessageIds: [],
          replyPriority: "none",
        }),
      });
    const { orchestrator, workspace, log } = await createFixture({ run }, 900_000, identity);
    const first = createMessageEvent(
      createMessage(discord.message.id, {
        channelId: discord.channel.id,
        mentions: [{ id: user.id, displayName: user.username }],
      }),
    );
    await log.append(first);
    await orchestrator.onMessage(first, workspace, discord.message);

    const followUp = await discord.createMessage({ content: "thanks" });
    const second = createMessageEvent(
      createMessage(followUp.id, {
        channelId: discord.channel.id,
        content: "thanks",
        cleanContent: "thanks",
      }),
    );
    await log.append(second);
    await orchestrator.onMessage(second, workspace, followUp);

    expect(discord.sentMessages.map((message) => message.content)).toEqual(["first reply"]);
    expect(run).toHaveBeenCalledTimes(2);
    const stayRequest = run.mock.calls.find(([request]) => request.traceLabel === "stay_decision")?.[0];
    const stateJson = stayRequest?.messages
      .find((message) => message.role === "system")
      ?.content.match(/<engagement_state>([\s\S]*?)<\/engagement_state>/)?.[1];
    if (!stateJson) throw new Error("Stay decision did not receive its conversation state.");
    const state: unknown = JSON.parse(stateJson);
    expect(state).toMatchObject({
      recentBotMessageIds: [discord.sentMessages[0]?.id],
      lastBotMessageAt: expect.any(String),
      humanMessagesSinceLastBot: 1,
    });
  });
});

async function createFixture(
  runner: AgentRunner,
  ambientDecisionCooldownMs = 900_000,
  identity: BotIdentity = botIdentity,
) {
  const root = await createTestWorkspace("dbh2-orchestrator-");
  const agentsPath = join(root, "AGENTS.md");
  await writeFile(agentsPath, "runtime instructions", "utf8");
  const config: AppConfig = {
    ...defaultConfig,
    conversation: {
      ...defaultConfig.conversation,
      notEngaged: {
        ...defaultConfig.conversation.notEngaged,
        ambientMinSilenceMs: 0,
        ambientDecisionCooldownMs,
        directTriggerDebounceMs: [0, 0],
      },
      engaged: {
        ...defaultConfig.conversation.engaged,
        followUpBatch: { ...defaultConfig.conversation.engaged.followUpBatch, maxMessages: 1 },
      },
    },
    memory: {
      ...defaultConfig.memory,
      compaction: { ...defaultConfig.memory.compaction, enabled: false },
      dream: { ...defaultConfig.memory.dream, enabled: false },
    },
  };
  const workspace: GuildWorkspace = { guildId: "g1", guildRoot: root, workspaceRoot: root };
  return {
    workspace,
    log: new EventLog(root),
    orchestrator: new ConversationOrchestrator(config, agentsPath, runner, identity),
  };
}
