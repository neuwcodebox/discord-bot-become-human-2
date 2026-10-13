import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildEngagementDecisionContext,
  buildReactionContext,
  buildResponseContext,
  buildStayDecisionContext,
} from "../src/agent/context-builder.js";
import { buildDreamPhase1Context } from "../src/agent/dream-context-builder.js";
import { defaultConfig } from "../src/config.js";
import type {
  AgentContextMessage,
  AgentRole,
  BotIdentity,
  ConversationRuntimeState,
  EngagementDecision,
} from "../src/types.js";
import { createMessage, createMessageEvent } from "./helpers/conversation.js";
import { createTestWorkspace } from "./helpers/workspace.js";

const botIdentity: BotIdentity = {
  userId: "bot-self",
  username: "self-bot",
  globalName: "Self Bot",
  tag: "self-bot#0001",
  mention: "<@bot-self>",
  names: ["Self Bot", "self-bot", "self-bot#0001"],
};
const responseTask: EngagementDecision = {
  engage: true,
  confidence: 1,
  reason: "direct",
  targetMessageIds: ["m1"],
  expectedRole: "answer_question",
};
describe("context builder", () => {
  it.each([
    { phase: "engagement", build: buildEngagementDecisionContext },
    { phase: "stay", build: buildStayDecisionContext },
  ])("keeps runtime scheduling out of $phase decisions", async ({ build }) => {
    const input = await contextFixture();
    const pendingTimer = setTimeout(() => {}, 0);
    clearTimeout(pendingTimer);
    const state: ConversationRuntimeState = {
      engagement: "engaged",
      lastBotMessageAt: "2026-05-11T12:00:00.000Z",
      lastHumanMessageAt: "2026-05-11T12:00:03.000Z",
      lastAmbientDecisionAt: "2026-05-11T12:00:02.000Z",
      recentBotMessageIds: ["b1"],
      consecutiveBotReplies: 1,
      humanMessagesSinceLastBot: 1,
      unrelatedHumanMessagesSinceLastBot: 0,
      cooldownUntil: "2026-05-11T12:00:30.000Z",
      pendingTimer,
      pendingFollowUp: {
        since: "2026-05-11T12:00:03.000Z",
        lastMessageAt: "2026-05-11T12:00:03.000Z",
        messageIds: ["m1"],
        relatedToBot: false,
        waitCount: 0,
      },
      ambientReplyTimes: [],
    };

    const context = await build({ ...input, state, currentMessage: createMessage() });
    const system = messageContent(context, "system");

    expect(system).toContain('"lastBotMessageAt": "2026-05-11T12:00:00.000Z"');
    for (const field of ["cooldownUntil", "lastAmbientDecisionAt", "pendingFollowUp", "pendingTimer"]) {
      expect(system).not.toContain(field);
    }
  });

  it("limits the reaction agent to one emoji reaction without a text reply", async () => {
    const input = await contextFixture();
    const context = await buildReactionContext({
      ...input,
      task: {
        stayEngaged: true,
        action: "react",
        confidence: 0.9,
        reason: "acknowledge",
        attention: "directed_at_bot",
        targetMessageIds: ["m1"],
        reactionHint: "ack",
        replyPriority: "none",
      },
    });

    expect(messageContent(context, "system")).toContain("discord_react");
    expect(messageContent(context, "system")).toContain("Do not write a Discord message");
    expect(messageContent(context, "system")).toContain("Use exactly one tool call and then stop");
    expect(messageContent(context, "user")).toContain('id="m1"');
  });

  it("keeps runtime instructions and persona documents in the system role", async () => {
    const input = await contextFixture();
    await writeWorkspaceFile(input.workspaceRoot, "SOUL.md", "soul persona");
    await writeWorkspaceFile(input.workspaceRoot, "GROUP.md", "group conventions");
    await writeWorkspaceFile(input.workspaceRoot, "TOOLS.md", "tool reference");

    const context = await buildResponseContext(input);
    const system = messageContent(context, "system");
    const user = messageContent(context, "user");

    for (const instruction of [
      "runtime instructions",
      "soul persona",
      "group conventions",
      "tool reference",
    ]) {
      expect(system).toContain(instruction);
      expect(user).not.toContain(instruction);
    }
    expect(system).toContain("Focus on targetMessageIds");
    expect(system).toContain("Do not mention internal JSON");
  });

  it("identifies this bot separately from other bots in the response transcript", async () => {
    const input = await contextFixture([
      createMessage(),
      createMessage("m2", {
        author: { id: "bot-self", username: "Self Bot", displayName: "Self Bot", isBot: true },
      }),
      createMessage("m3", {
        author: { id: "bot-other", username: "Other Bot", displayName: "Other Bot", isBot: true },
      }),
    ]);
    const context = await buildResponseContext(input);
    const system = messageContent(context, "system");
    const user = messageContent(context, "user");

    expect(system).toContain("discord_user_id: bot-self");
    expect(system).toContain("mention: <@bot-self>");
    expect(user).toContain('<msg id="m1" author="User"');
    expect(user).toContain('<msg id="m2" author="Self Bot" t="2026-05-11T21:00:03.000+09:00" me>');
    expect(user).toContain('<msg id="m3" author="Other Bot" t="2026-05-11T21:00:03.000+09:00" bot>');
  });

  it("loads only relevant user profiles as user context", async () => {
    const input = await contextFixture();
    await writeWorkspaceFile(input.workspaceRoot, "users/u1/USER.md", "relevant profile fact");
    await writeWorkspaceFile(input.workspaceRoot, "users/u2/USER.md", "unrelated private fact");

    const context = await buildResponseContext(input);

    expect(messageContent(context, "user")).toContain("relevant profile fact");
    expect(messageContent(context, "system")).not.toContain("relevant profile fact");
    expect(context.map((message) => message.content).join("\n")).not.toContain("unrelated private fact");
  });

  it("keeps Dream memory instructions in the system role", async () => {
    const input = await contextFixture();
    const context = await buildDreamPhase1Context({
      ...input,
      history: [],
      inbox: [],
      memory: "existing durable memory",
      userFiles: new Map(),
      existingSkillNames: [],
      reason: "test",
    });

    expect(messageContent(context, "system")).toContain("Do NOT edit files");
    expect(messageContent(context, "system")).toContain(
      "Only preserve information that is likely to remain useful later",
    );
    expect(messageContent(context, "user")).toContain("existing durable memory");
    expect(messageContent(context, "system")).not.toContain("existing durable memory");
  });

  it("limits response history to recent channel summaries and a capped transcript", async () => {
    const input = await contextFixture(
      Array.from({ length: 8 }, (_, index) => ({
        ...createMessage(`m${index + 1}`),
        cleanContent: `latest message ${index} ${"x".repeat(40)}`,
      })),
    );
    const history = [
      { cursor: 1, channelIds: ["c1"], summary: "old excluded summary" },
      { cursor: 2, channelIds: ["c1"], summary: "recent useful context" },
      { cursor: 3, channelIds: ["other-channel"], summary: "unrelated channel context" },
    ].map((entry) => ({
      ...entry,
      time: "2026-05-11T12:00:00.000Z",
      fromEventCursor: 1,
      toEventCursor: 10,
      participants: ["u1"],
      memoryTargets: ["memory/MEMORY.md"],
    }));
    await writeWorkspaceFile(
      input.workspaceRoot,
      "memory/history.jsonl",
      `${history.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );

    const context = await buildResponseContext({
      ...input,
      config: {
        ...defaultConfig,
        context: { ...defaultConfig.context, maxTranscriptChars: 180, maxArchiveSummariesInContext: 1 },
      },
      targetMessageIds: ["m8"],
      task: { ...responseTask, targetMessageIds: ["m8"] },
    });
    const user = messageContent(context, "user");

    expect(user).toContain("recent useful context");
    expect(user).not.toContain("old excluded summary");
    expect(user).not.toContain("unrelated channel context");
    expect(user).toContain("... (truncated)");
  });
});

async function contextFixture(messages = [createMessage()]) {
  const workspaceRoot = await createTestWorkspace("dbh2-context-");
  const agentsPath = join(workspaceRoot, "AGENTS.md");
  await writeFile(agentsPath, "runtime instructions", "utf8");
  return {
    agentsPath,
    workspaceRoot,
    config: defaultConfig,
    events: messages.map(createMessageEvent),
    targetMessageIds: ["m1"],
    task: responseTask,
    botIdentity,
  };
}

async function writeWorkspaceFile(workspaceRoot: string, relativePath: string, content: string) {
  const path = join(workspaceRoot, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

function messageContent(messages: AgentContextMessage[], role: AgentRole): string {
  return messages.find((message) => message.role === role)?.content ?? "";
}
