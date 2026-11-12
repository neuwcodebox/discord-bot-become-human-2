import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildResponseContext } from "../src/agent/context-builder.js";
import { defaultConfig } from "../src/config.js";
import { normalizeContextMessages, truncateText, truncateTextParts } from "../src/context/limits.js";
import { buildTranscriptMessages } from "../src/conversation/transcript-builder.js";
import type { AgentContextMessage, NormalizedDiscordEvent } from "../src/types.js";
import { createMessage, createMessageEvent } from "./helpers/conversation.js";
import { createTestWorkspace } from "./helpers/workspace.js";

const options = { guildId: "g1", channelId: "c1", timezone: "UTC", botUserId: "self" };

describe("append-friendly observation context", () => {
  it("preserves all old API message boundaries when new targets and messages arrive", async () => {
    const workspaceRoot = await createTestWorkspace("dbh2-prefix-");
    const agentsPath = join(workspaceRoot, "AGENTS.md");
    await writeFile(agentsPath, "fixed runtime instructions");
    await mkdir(join(workspaceRoot, "users/u1"), { recursive: true });
    await writeFile(join(workspaceRoot, "users/u1/USER.md"), "stable profile");
    const firstMessage = createMessage("a");
    const secondMessage = createMessage("b", {
      createdAt: "2026-05-11T12:00:04.000Z",
      author: { id: "other", displayName: "Other", username: "other", isBot: false },
      replyTo: { messageId: "a", authorId: "u1", authorDisplayName: "User", contentPreview: "reply preview" },
    });
    const input = {
      agentsPath,
      workspaceRoot,
      config: defaultConfig,
      events: [createMessageEvent(firstMessage)],
      targetMessageIds: ["a"],
      task: {
        engage: true as const,
        confidence: 1,
        reason: "direct",
        targetMessageIds: ["wrong"],
        expectedRole: "answer_question" as const,
      },
      botIdentity: {
        userId: "self",
        username: "self",
        globalName: null,
        tag: "self",
        mention: "<@self>",
        names: ["self"],
      },
    };
    const before = await buildResponseContext(input);
    const after = await buildResponseContext({
      ...input,
      events: [...input.events, createMessageEvent(secondMessage)],
      targetMessageIds: ["a", "b"],
    });
    expect(after.slice(0, before.length - 1)).toEqual(before.slice(0, -1));
    expect(after[0]).toMatchObject({ role: "system", cacheBreakpoint: true });
    expect(after[0]?.content).not.toContain("<task>");
    expect(after.at(-1)?.role).toBe("developer");
    expect(after.at(-1)?.content).toContain('"a",\n    "b"');
    expect(after.at(-1)?.content).not.toContain("wrong");
    const observations = after.filter((message) => message.role === "user");
    expect(observations[0]?.content).toContain("stable profile");
    expect(observations.at(-1)?.content).toContain('<reply id="a" author="User">');
    expect(observations.at(-1)?.content).toContain("reply preview");
    expect(observations.flatMap((message) => message.content.match(/<msg\b[^>]*\btarget\b/g) ?? [])).toEqual(
      [],
    );
    for (const message of observations.filter((item) => item.content.includes("<msg "))) {
      expect(message.content).toMatch(/^<transcript /);
      expect(message.content).toMatch(/<\/transcript>$/);
    }
  });

  it("keeps edits, deletions, reactions and bot attribution in observed records", () => {
    const first = createMessage("a", {
      author: { id: "self", username: "self", displayName: "Self", isBot: true },
    });
    const second = createMessage("b", { cleanContent: "unchanged" });
    const events: NormalizedDiscordEvent[] = [createMessageEvent(first), createMessageEvent(second)];
    const before = buildTranscriptMessages(events, options);
    events.push({
      ...createMessageEvent(first),
      type: "message_update",
      payload: { ...first, cleanContent: "edited", editedAt: "2026-05-11T12:01:00.000Z" },
    });
    events.push({
      type: "message_delete",
      time: "2026-05-11T12:02:00.000Z",
      guildId: "g1",
      channelId: "c1",
      messageId: "a",
      payload: { deletedAt: "2026-05-11T12:02:00.000Z" },
    });
    events.push({
      type: "reaction_add",
      time: "2026-05-11T12:02:00.000Z",
      guildId: "g1",
      channelId: "c1",
      messageId: "a",
      authorId: "u1",
      payload: { emoji: "👍", userId: "u1" },
    });
    const after = buildTranscriptMessages(events, options);
    expect(after[1]).toBe(before[1]);
    expect(after[0]).toContain(" me ");
    expect(after[0]).toContain("<text>edited</text>");
    expect(after[0]).toContain("<deleted ");
    expect(after[0]).toContain('<rx emoji="👍" count="1"');
  });
});

describe("split observation budgets", () => {
  it("retains stable whole parts and caps their total rather than each independently", () => {
    const parts = ["a".repeat(30), "b".repeat(30), "c".repeat(30)];
    const capped = truncateTextParts(parts, 70);
    expect(capped[0]).toBe(parts[0]);
    expect(capped.join("\n\n")).toBe(truncateText(parts.join("\n\n"), 70).text);
    expect(capped).toHaveLength(2);
  });

  it("preserves original prefix truncation at separator boundaries and tiny limits", () => {
    for (const parts of [
      ["abc", "defgh", "ijk"],
      ["", "abc", "", "defgh"],
    ]) {
      for (let limit = 0; limit < 40; limit++) {
        expect(truncateTextParts(parts, limit).join("\n\n")).toBe(
          truncateText(parts.join("\n\n"), limit).text,
        );
      }
    }
  });

  it("protects final task authority and position while preserving a single group budget", () => {
    const messages: AgentContextMessage[] = [
      { role: "system", content: "stable", cacheBreakpoint: true },
      { role: "user", content: "a".repeat(40), budgetGroup: "observations" },
      { role: "user", content: "b".repeat(40), budgetGroup: "observations" },
      { role: "developer", content: "task" },
    ];
    const normalized = normalizeContextMessages(
      messages,
      {
        ...defaultConfig,
        context: { ...defaultConfig.context, maxContextMessageChars: 60 },
      },
      100_000,
    );
    expect(normalized[0]).toEqual(messages[0]);
    expect(normalized.at(-1)).toEqual(messages.at(-1));
    expect(
      normalized
        .filter((message) => message.role === "user")
        .map((message) => message.content)
        .join("\n\n"),
    ).toHaveLength(60);
  });

  it("retains legacy ungrouped caps and newest-unit selection", () => {
    const messages: AgentContextMessage[] = [
      { role: "system", content: "instructions" },
      { role: "user", content: "old".repeat(1800) },
      { role: "user", content: "new".repeat(1800) },
      { role: "developer", content: "latest task" },
    ];
    const normalized = normalizeContextMessages(messages, defaultConfig, 1000);
    expect(normalized.map((message) => message.role)).toEqual(["system", "user", "developer"]);
    expect(normalized[1]?.content).toBe(messages[2]?.content);
  });
});
