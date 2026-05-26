import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildDreamPhase1Context,
  buildReactionContext,
  buildResponseContext,
  buildStayDecisionContext,
} from "../src/agent/context-builder.js";
import { defaultConfig } from "../src/config.js";
import type { ConversationRuntimeState, NormalizedDiscordMessage } from "../src/types.js";

describe("context builder", () => {
  it("does not expose runtime scheduling fields to stay decision context", async () => {
    const root = await mkdtemp(join(tmpdir(), "dbh2-context-"));
    const agentsPath = join(root, "AGENTS.md");
    await writeFile(agentsPath, "runtime instructions", "utf8");
    const message = normalizedMessage("m1");
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
      pendingFollowUp: {
        since: "2026-05-11T12:00:03.000Z",
        lastMessageAt: "2026-05-11T12:00:03.000Z",
        messageIds: ["m1"],
        relatedToBot: false,
        waitCount: 0,
      },
      ambientReplyTimes: [],
    };

    const context = await buildStayDecisionContext({
      agentsPath,
      workspaceRoot: root,
      state,
      events: [
        {
          type: "message_create",
          time: message.createdAt,
          guildId: message.guildId,
          channelId: message.channelId,
          messageId: message.id,
          authorId: message.author.id,
          payload: message,
        },
      ],
      currentMessage: message,
    });
    const systemMessage = context.find((entry) => entry.role === "system")?.content ?? "";

    expect(systemMessage).toContain("lastBotMessageAt");
    expect(systemMessage).toContain("<action_semantics>");
    expect(systemMessage).toContain("react:");
    expect(systemMessage).toContain("one Discord emoji reaction only");
    expect(systemMessage).toContain("Do not use wait because of cooldown");
    expect(systemMessage).not.toContain("cooldownUntil");
    expect(systemMessage).not.toContain("lastAmbientDecisionAt");
    expect(systemMessage).not.toContain("pendingFollowUp");
    expect(systemMessage).not.toContain("waitCount");
  });

  it("builds reaction context that asks for a Discord reaction instead of a text reply", async () => {
    const root = await mkdtemp(join(tmpdir(), "dbh2-context-"));
    const agentsPath = join(root, "AGENTS.md");
    await writeFile(agentsPath, "runtime instructions", "utf8");
    const message = normalizedMessage("m1");

    const context = await buildReactionContext({
      agentsPath,
      workspaceRoot: root,
      events: [
        {
          type: "message_create",
          time: message.createdAt,
          guildId: message.guildId,
          channelId: message.channelId,
          messageId: message.id,
          authorId: message.author.id,
          payload: message,
        },
      ],
      targetMessageIds: ["m1"],
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

    expect(context[0]?.content).toContain("discord_react");
    expect(context[0]?.content).toContain("Do not write a Discord message");
    expect(context.find((entry) => entry.role === "system")?.content).toContain('"reactionHint": "ack"');
    expect(context.find((entry) => entry.role === "user")?.content).toContain('id="m1"');
    expect(context.find((entry) => entry.role === "user")?.content).toContain("target");
    expect(context.find((entry) => entry.role === "user")?.content).toContain("Common neutral examples");
    expect(context.find((entry) => entry.role === "user")?.content).toContain("choose naturally");
  });

  it("adds response guardrails without overriding the persona documents", async () => {
    const root = await mkdtemp(join(tmpdir(), "dbh2-context-"));
    const agentsPath = join(root, "AGENTS.md");
    await writeFile(agentsPath, "runtime instructions", "utf8");
    const message = normalizedMessage("m1");

    const context = await buildResponseContext({
      agentsPath,
      workspaceRoot: root,
      config: defaultConfig,
      events: [
        {
          type: "message_create",
          time: message.createdAt,
          guildId: message.guildId,
          channelId: message.channelId,
          messageId: message.id,
          authorId: message.author.id,
          payload: message,
        },
      ],
      targetMessageIds: ["m1"],
      task: {
        engage: true,
        confidence: 1,
        reason: "direct",
        targetMessageIds: ["m1"],
        expectedRole: "answer_question",
      },
    });
    const systemMessage = context.find((entry) => entry.role === "system")?.content ?? "";

    expect(systemMessage).toContain("<guardrails>");
    expect(systemMessage).toContain("Focus on targetMessageIds");
    expect(systemMessage).toContain("Do not mention internal JSON");
    expect(systemMessage).toContain("Use tools only when they are actually needed");
  });

  it("adds durable memory guardrails to Dream context", async () => {
    const root = await mkdtemp(join(tmpdir(), "dbh2-context-"));
    const agentsPath = join(root, "AGENTS.md");
    await writeFile(agentsPath, "runtime instructions", "utf8");

    const context = await buildDreamPhase1Context({
      agentsPath,
      workspaceRoot: root,
      history: [],
      inbox: [],
      memory: "",
      userFiles: new Map(),
      existingSkillNames: [],
      config: defaultConfig,
      reason: "test",
    });
    const allContent = context.map((entry) => entry.content).join("\n");

    expect(allContent).toContain("<guardrails>");
    expect(allContent).toContain("one-off jokes");
    expect(allContent).toContain("temporary tests");
    expect(allContent).toContain("simple thanks");
    expect(allContent).toContain("transient debugging logs");
  });

  it("includes capped archive summaries and transcript in response context", async () => {
    const root = await mkdtemp(join(tmpdir(), "dbh2-context-"));
    const agentsPath = join(root, "AGENTS.md");
    await writeFile(agentsPath, "runtime instructions", "utf8");
    await mkdir(join(root, "memory"), { recursive: true });
    await writeFile(
      join(root, "memory", "history.jsonl"),
      `${JSON.stringify({
        cursor: 1,
        time: "2026-05-11T12:00:00.000Z",
        fromEventCursor: 1,
        toEventCursor: 10,
        channelIds: ["c1"],
        participants: ["u1"],
        summary: "old useful context",
        memoryTargets: ["memory/MEMORY.md"],
      })}\n`,
      "utf8",
    );
    const config = {
      ...defaultConfig,
      context: {
        ...defaultConfig.context,
        maxTranscriptChars: 180,
        maxArchiveSummariesInContext: 1,
      },
    };
    const events = Array.from({ length: 8 }, (_, index) => {
      const message = normalizedMessage(`m${index + 1}`);
      return {
        type: "message_create" as const,
        time: message.createdAt,
        guildId: message.guildId,
        channelId: message.channelId,
        messageId: message.id,
        authorId: message.author.id,
        payload: { ...message, cleanContent: `latest message ${index} ${"x".repeat(40)}` },
      };
    });

    const context = await buildResponseContext({
      agentsPath,
      workspaceRoot: root,
      config,
      events,
      targetMessageIds: ["m8"],
      task: {
        engage: true,
        confidence: 1,
        reason: "direct",
        targetMessageIds: ["m8"],
        expectedRole: "answer_question",
      },
    });
    const userMessage = context.find((entry) => entry.role === "user")?.content ?? "";

    expect(userMessage).toContain("<archive_summaries>");
    expect(userMessage).toContain("old useful context");
    expect(userMessage).toContain("... (truncated)");
  });
});

function normalizedMessage(id: string): NormalizedDiscordMessage {
  return {
    id,
    guildId: "g1",
    channelId: "c1",
    author: { id: "u1", username: "user", displayName: "User", isBot: false },
    content: "latest message",
    cleanContent: "latest message",
    createdAt: "2026-05-11T12:00:03.000Z",
    mentions: [],
    attachments: [],
    embeds: [],
    reactions: [],
    links: [],
  };
}
