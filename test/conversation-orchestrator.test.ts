import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentRunner } from "../src/agent/runner.js";
import { defaultConfig } from "../src/config.js";
import { ConversationOrchestrator } from "../src/conversation/orchestrator.js";
import { EventLog } from "../src/memory/event-log.js";
import type {
  AgentRunRequest,
  AgentRunResult,
  AppConfig,
  GuildWorkspace,
  NormalizedDiscordEvent,
} from "../src/types.js";

type MessageCreateEvent = Extract<NormalizedDiscordEvent, { type: "message_create" }>;

describe("conversation orchestrator", () => {
  it("rate limits not-engaged ambient decision calls even when engagement is declined", async () => {
    const root = await mkdtemp(join(tmpdir(), "dbh2-orchestrator-"));
    const agentsPath = join(root, "AGENTS.md");
    await writeFile(agentsPath, "runtime instructions", "utf8");
    const config: AppConfig = {
      ...defaultConfig,
      conversation: {
        ...defaultConfig.conversation,
        notEngaged: {
          ...defaultConfig.conversation.notEngaged,
          ambientMinSilenceMs: 0,
          ambientDecisionCooldownMs: 900000,
        },
      },
      memory: {
        ...defaultConfig.memory,
        compaction: { ...defaultConfig.memory.compaction, enabled: false },
        dream: { ...defaultConfig.memory.dream, enabled: false },
      },
    };
    const runner = new CountingRunner();
    const orchestrator = new ConversationOrchestrator(config, agentsPath, runner, {
      userId: "bot-1",
      username: "test-bot",
      globalName: "Test Bot",
      tag: "test-bot#0001",
      mention: "<@bot-1>",
      names: ["Test Bot", "test-bot", "test-bot#0001"],
    });
    const workspace: GuildWorkspace = { guildId: "g1", guildRoot: root, workspaceRoot: root };
    const log = new EventLog(root);
    const first = messageEvent("m1");
    const second = messageEvent("m2");

    await log.append(first);
    await orchestrator.onMessage(first, workspace);
    await log.append(second);
    await orchestrator.onMessage(second, workspace);

    expect(runner.traceLabels).toEqual(["engagement_decision"]);
  });
});

class CountingRunner implements AgentRunner {
  readonly traceLabels: string[] = [];

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    this.traceLabels.push(request.traceLabel ?? "");
    return {
      text: JSON.stringify({
        engage: false,
        confidence: 0.1,
        reason: "background chatter",
        targetMessageIds: [],
        expectedRole: "other",
      }),
    };
  }
}

function messageEvent(messageId: string): MessageCreateEvent {
  const createdAt = new Date().toISOString();
  return {
    type: "message_create",
    time: createdAt,
    guildId: "g1",
    channelId: "c1",
    messageId,
    authorId: "u1",
    payload: {
      id: messageId,
      guildId: "g1",
      channelId: "c1",
      author: { id: "u1", username: "user", displayName: "User", isBot: false },
      content: "background message",
      cleanContent: "background message",
      createdAt,
      mentions: [],
      attachments: [],
      embeds: [],
      reactions: [],
      links: [],
    },
  };
}
