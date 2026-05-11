import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildStayDecisionContext } from "../src/agent/context-builder.js";
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
    const developerMessage = context.find((entry) => entry.role === "developer")?.content ?? "";

    expect(developerMessage).toContain("lastBotMessageAt");
    expect(developerMessage).not.toContain("cooldownUntil");
    expect(developerMessage).not.toContain("pendingFollowUp");
    expect(developerMessage).not.toContain("waitCount");
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
