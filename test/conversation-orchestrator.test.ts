import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { z } from "zod";
import type { AgentRunner } from "../src/agent/runner.js";
import { defaultConfig } from "../src/config.js";
import { ConversationOrchestrator } from "../src/conversation/orchestrator.js";
import { createBotIdentity } from "../src/discord/bot-identity.js";
import { EventLog } from "../src/memory/event-log.js";
import type {
  AgentRunRequest,
  AgentRunResult,
  AppConfig,
  BotIdentity,
  GuildWorkspace,
  StayDecision,
} from "../src/types.js";
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

afterEach(() => vi.useRealTimers());

describe("conversation orchestrator", () => {
  it.each(["다른 bot 상태 확인해 줘", "BOT 도와줘", "robot 이야기"])(
    "sends generic bot text through ambient judgment instead of a forced response: %s",
    async (content) => {
      const discord = await createDiscordFixture();
      const identity = createBotIdentity({
        id: discord.client.user.id,
        username: "chatter",
        globalName: "채터",
        tag: "chatter#0001",
      });
      const run = vi.fn<AgentRunner["run"]>().mockResolvedValue({ text: declinedDecision });
      const { orchestrator, workspace, log } = await createFixture({ run }, 0, identity);
      const event = createMessageEvent(
        createMessage(discord.message.id, {
          channelId: discord.channel.id,
          content,
          cleanContent: content,
        }),
      );
      await log.append(event);
      await orchestrator.onMessage(event, workspace, discord.message);
      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
      expect(run.mock.calls[0]?.[0].traceLabel).toBe("engagement_decision");
      expect(discord.sentMessages).toHaveLength(0);
    },
  );

  it.each(["name", "mention", "reply"])(
    "preserves direct %s triggers with the real identity",
    async (kind) => {
      const discord = await createDiscordFixture();
      const identity = createBotIdentity({
        id: discord.client.user.id,
        username: "chatter",
        globalName: "채터",
        tag: "chatter#0001",
      });
      const run = vi.fn<AgentRunner["run"]>().mockResolvedValue({ text: "hello" });
      const { orchestrator, workspace, log } = await createFixture({ run }, 0, identity);
      const content = kind === "name" ? "Chatter 도와줘" : "도와줘";
      const event = createMessageEvent(
        createMessage(discord.message.id, {
          channelId: discord.channel.id,
          content,
          cleanContent: content,
          ...(kind === "mention" ? { mentions: [{ id: identity.userId, displayName: "chatter" }] } : {}),
          ...(kind === "reply"
            ? { replyTo: { messageId: "earlier-bot-message", authorId: identity.userId } }
            : {}),
        }),
      );
      await log.append(event);
      await orchestrator.onMessage(event, workspace, discord.message);
      await vi.waitFor(() => expect(discord.sentMessages).toHaveLength(1));
      expect(run.mock.calls.map(([request]) => request.traceLabel)).toEqual(["response"]);
    },
  );

  it("rate limits ambient decisions even when engagement is declined", async () => {
    const run = vi.fn<AgentRunner["run"]>().mockResolvedValue({ text: declinedDecision });
    const { orchestrator, workspace, log } = await createFixture({ run });

    for (const id of ["m1", "m2"]) {
      const event = createMessageEvent(createMessage(id));
      await log.append(event);
      await orchestrator.onMessage(event, workspace);
      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
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
      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(id === "m1" ? 1 : 2));
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
    await vi.waitFor(() => expect(discord.sentMessages).toHaveLength(1));

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
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));

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
        ambientDebounceMs: [0, 0],
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
  const orchestrator = new ConversationOrchestrator(config, agentsPath, runner, identity);
  onTestFinished(() => orchestrator.dispose());
  return {
    workspace,
    log: new EventLog(root),
    orchestrator,
  };
}

const activeSchema = z.object({ id: z.string(), updatesUsed: z.number() });
const incomingSchema = z.array(z.string());

function blockValue(request: AgentRunRequest, name: string): unknown {
  const content = request.messages.map((message) => message.content).join("\n");
  const match = content.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  if (!match?.[1]) throw new Error(`Missing context block: ${name}`);
  return JSON.parse(match[1]);
}

function stayReply(
  request: AgentRunRequest,
  control: "continue" | "update" | "cancel" = "continue",
  overrides: Partial<StayDecision> = {},
): AgentRunResult {
  const active = request.messages.some((message) => message.content.includes("<active_response>"))
    ? activeSchema.parse(blockValue(request, "active_response"))
    : undefined;
  const incoming = incomingSchema.parse(blockValue(request, "incoming_message_ids"));
  return {
    text: JSON.stringify({
      stayEngaged: true,
      action: "silent_track",
      confidence: 1,
      reason: "contextual decision",
      attention: "directed_at_bot",
      targetMessageIds: incoming,
      replyPriority: "none",
      ...(active
        ? { responseControl: { responseId: active.id, action: control, messageIds: incoming } }
        : {}),
      ...overrides,
    }),
  };
}

async function waitForResult(
  request: AgentRunRequest,
  pending: Promise<AgentRunResult>,
): Promise<AgentRunResult> {
  const signal = request.signal;
  signal?.throwIfAborted();
  let cancel: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(signal?.reason);
    signal?.addEventListener("abort", cancel, { once: true });
  });
  try {
    return await Promise.race([pending, aborted]);
  } finally {
    if (cancel) signal?.removeEventListener("abort", cancel);
  }
}

async function streamFixture(
  run: AgentRunner["run"],
  timing: { debounceMs?: number; maxMessages?: number; maxWaitMs?: number; maxRecentMessages?: number } = {},
) {
  const root = await createTestWorkspace("dbh2-stream-");
  const agentsPath = join(root, "AGENTS.md");
  await writeFile(agentsPath, "runtime instructions", "utf8");
  const discord = await createDiscordFixture();
  const identity: BotIdentity = {
    userId: discord.client.user.id,
    username: "bot",
    globalName: null,
    tag: "bot",
    mention: discord.client.user.toString(),
    names: ["bot"],
  };
  const config: AppConfig = {
    ...defaultConfig,
    streaming: { ...defaultConfig.streaming, enabled: false },
    conversation: {
      ...defaultConfig.conversation,
      maxRecentMessages: timing.maxRecentMessages ?? 100,
      cooldownMs: [0, 0],
      notEngaged: { ...defaultConfig.conversation.notEngaged, directTriggerDebounceMs: [0, 0] },
      engaged: {
        ...defaultConfig.conversation.engaged,
        followUpBatch: {
          quietDebounceMs: [timing.debounceMs ?? 0, timing.debounceMs ?? 0],
          directTriggerDebounceMs: [timing.debounceMs ?? 0, timing.debounceMs ?? 0],
          maxMessages: timing.maxMessages ?? 1,
          maxWaitMs: timing.maxWaitMs ?? 15_000,
        },
      },
    },
    memory: {
      ...defaultConfig.memory,
      compaction: { ...defaultConfig.memory.compaction, enabled: false },
      dream: { ...defaultConfig.memory.dream, enabled: false },
    },
  };
  const workspace: GuildWorkspace = { guildId: "g1", guildRoot: root, workspaceRoot: root };
  const log = new EventLog(root);
  const orchestrator = new ConversationOrchestrator(config, agentsPath, { run }, identity);
  onTestFinished(() => orchestrator.dispose());
  async function publish(
    text: string,
    input: { otherAuthor?: boolean; mention?: boolean; replyToHuman?: boolean } = {},
  ) {
    const message = await discord.createMessage({
      content: text,
      ...(input.otherAuthor ? { authorId: "100000000000000099" } : {}),
    });
    const event = createMessageEvent(
      createMessage(message.id, {
        channelId: discord.channel.id,
        content: text,
        cleanContent: text,
        author: {
          id: message.author.id,
          username: message.author.username,
          displayName: message.author.username,
          isBot: false,
        },
        ...(input.mention ? { mentions: [{ id: identity.userId, displayName: "bot" }] } : {}),
        ...(input.replyToHuman ? { replyTo: { messageId: "human-message", authorId: "other-human" } } : {}),
      }),
    );
    await log.append(event);
    await orchestrator.onMessage(event, workspace, message);
    return event;
  }
  return { orchestrator, publish, discord, log, workspace };
}

describe("conversation message stream", () => {
  it("uses edits captured before a decision instead of the original received message", async () => {
    vi.useFakeTimers();
    const run = vi.fn<AgentRunner["run"]>().mockResolvedValue({ text: "부산 답변" });
    const fixture = await streamFixture(run, { debounceMs: 100, maxMessages: 1000 });
    const event = await fixture.publish("서울 질문", { mention: true });
    await fixture.log.append({
      ...event,
      type: "message_update",
      payload: { ...event.payload, cleanContent: "부산 질문" },
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    const context = run.mock.calls[0]?.[0].messages.map((message) => message.content).join("\n");
    expect(context).toContain("부산 질문");
    expect(context).not.toContain("서울 질문");
  });

  it("does not answer a request deleted before its batch decision", async () => {
    vi.useFakeTimers();
    const read = vi.spyOn(EventLog.prototype, "readAll");
    onTestFinished(() => read.mockRestore());
    const run = vi.fn<AgentRunner["run"]>().mockResolvedValue({ text: "should not be sent" });
    const fixture = await streamFixture(run);
    const event = await fixture.publish("삭제할 질문", { mention: true });
    await fixture.log.append({
      type: "message_delete",
      time: event.time,
      guildId: event.guildId,
      channelId: event.channelId,
      messageId: event.messageId,
      payload: { deletedAt: event.time },
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(read).toHaveBeenCalled());
    const captured = read.mock.results[0];
    if (captured?.type === "return") await captured.value;
    await vi.advanceTimersByTimeAsync(0);
    expect(run).not.toHaveBeenCalled();
  });

  it("preserves a new question batched with cancellation of the previous request", async () => {
    const reply = Promise.withResolvers<AgentRunResult>();
    let responses = 0;
    const run = vi.fn<AgentRunner["run"]>(async (request) => {
      if (request.traceLabel === "stay_decision") {
        const ids = incomingSchema.parse(blockValue(request, "incoming_message_ids"));
        const active = activeSchema.parse(blockValue(request, "active_response"));
        return stayReply(request, "cancel", {
          stayEngaged: false,
          action: "reply",
          targetMessageIds: ids.slice(-1),
          responseControl: { responseId: active.id, action: "cancel", messageIds: ids.slice(0, 1) },
        });
      }
      responses += 1;
      return responses === 1 ? waitForResult(request, reply.promise) : { text: "새 질문의 답변" };
    });
    const fixture = await streamFixture(run, { debounceMs: 50, maxMessages: 1000 });
    await fixture.publish("원래 질문", { mention: true });
    await vi.waitFor(() => expect(responses).toBe(1));
    await fixture.publish("그 질문은 이제 됐어");
    await fixture.publish("대신 이 질문에 답해줘", { mention: true });
    await vi.waitFor(() =>
      expect(fixture.discord.sentMessages.map((message) => message.content)).toEqual(["새 질문의 답변"]),
    );
  });

  it("keeps the completed bot reply in context when revisiting a deferred question", async () => {
    const reply = Promise.withResolvers<AgentRunResult>();
    let responses = 0;
    const decisions: AgentRunRequest[] = [];
    const run = vi.fn<AgentRunner["run"]>(async (request) => {
      if (request.traceLabel === "stay_decision") {
        decisions.push(request);
        return stayReply(request, "continue", { action: "reply" });
      }
      responses += 1;
      return responses === 1 ? waitForResult(request, reply.promise) : { text: "후속 답변" };
    });
    const fixture = await streamFixture(run);
    const send = fixture.discord.send.getMockImplementation();
    if (!send) throw new Error("Missing fixture send implementation.");
    fixture.discord.send.mockImplementation(async (...args) => {
      const sent = await send(...args);
      await fixture.log.append(
        createMessageEvent(
          createMessage(sent.id, {
            channelId: fixture.discord.channel.id,
            cleanContent: sent.content,
            author: { id: fixture.discord.client.user.id, username: "bot", displayName: "bot", isBot: true },
          }),
        ),
      );
      return sent;
    });
    await fixture.publish("첫 질문", { mention: true });
    await vi.waitFor(() => expect(responses).toBe(1));
    await fixture.publish("추가 질문도 있어");
    await vi.waitFor(() => expect(decisions).toHaveLength(1));
    reply.resolve({ text: "첫 질문에 대한 중요한 답변" });
    await vi.waitFor(() => expect(decisions).toHaveLength(2));
    expect(decisions[1]?.messages.map((message) => message.content).join("\n")).toContain(
      "첫 질문에 대한 중요한 답변",
    );
  });

  it("preserves a separate model-selected question after a long burst of human chatter", async () => {
    const reply = Promise.withResolvers<AgentRunResult>();
    let responses = 0;
    let decisions = 0;
    const run = vi.fn<AgentRunner["run"]>(async (request) => {
      if (request.traceLabel === "stay_decision") {
        decisions += 1;
        const ids = incomingSchema.parse(blockValue(request, "incoming_message_ids"));
        return stayReply(request, "continue", {
          action: "reply",
          targetMessageIds: ids.slice(-1),
          replyPriority: "normal",
        });
      }
      responses += 1;
      return responses === 1 ? waitForResult(request, reply.promise) : { text: "두 번째 질문의 답변" };
    });
    const fixture = await streamFixture(run);
    await fixture.publish("첫 질문", { mention: true });
    await vi.waitFor(() => expect(responses).toBe(1));
    for (let index = 0; index < 12; index++) await fixture.publish(`잡담 ${index}`, { otherAuthor: true });
    const second = await fixture.publish("그리고 하나 더 궁금한 게 있어");
    await vi.waitFor(() => expect(decisions).toBe(1));
    expect(responses).toBe(1);
    reply.resolve({ text: "첫 번째 답변" });
    await vi.waitFor(() =>
      expect(fixture.discord.sentMessages.map((message) => message.content)).toEqual([
        "첫 번째 답변",
        "두 번째 질문의 답변",
      ]),
    );
    const lastRequest = run.mock.calls.findLast(([request]) => request.traceLabel === "response")?.[0];
    expect(lastRequest?.messages.map((message) => message.content).join("\n")).toContain(second.messageId);
  });

  it("does not reset a wait retry when messages arrive during the decision", async () => {
    const reply = Promise.withResolvers<AgentRunResult>();
    const pendingDecision = Promise.withResolvers<AgentRunResult>();
    const decisions: AgentRunRequest[] = [];
    const run = vi.fn<AgentRunner["run"]>(async (request) => {
      if (request.traceLabel !== "stay_decision") return waitForResult(request, reply.promise);
      decisions.push(request);
      return decisions.length === 1
        ? pendingDecision.promise
        : stayReply(request, "continue", { action: "wait" });
    });
    const fixture = await streamFixture(run);
    await fixture.publish("질문", { mention: true });
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    await fixture.publish("추가 정보");
    await vi.waitFor(() => expect(decisions).toHaveLength(1));
    await fixture.publish("이어서 보낸 정보");
    pendingDecision.resolve(stayReply(decisions[0] ?? failRequest(), "continue", { action: "wait" }));
    await vi.waitFor(() => expect(decisions).toHaveLength(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(decisions).toHaveLength(2);
  });

  it("rejects a control result naming another response or an older context message", async () => {
    const reply = Promise.withResolvers<AgentRunResult>();
    const steer = vi.fn<(contents: string) => boolean>(() => true);
    let activeRequest: AgentRunRequest | undefined;
    let decisions = 0;
    const run = vi.fn<AgentRunner["run"]>(async (request) => {
      if (request.traceLabel !== "stay_decision") {
        activeRequest = request;
        request.onControlReady?.({ steer });
        return waitForResult(request, reply.promise);
      }
      decisions += 1;
      const active = activeSchema.parse(blockValue(request, "active_response"));
      const ids = incomingSchema.parse(blockValue(request, "incoming_message_ids"));
      return stayReply(request, "cancel", {
        responseControl: {
          responseId: decisions === 1 ? "another-response" : active.id,
          action: "cancel",
          messageIds: decisions === 1 ? ids : ["older-context-message"],
        },
      });
    });
    const fixture = await streamFixture(run);
    await fixture.publish("질문", { mention: true });
    await vi.waitFor(() => expect(activeRequest).toBeDefined());
    await fixture.publish("새 메시지");
    await vi.waitFor(() => expect(decisions).toBe(1));
    await fixture.publish("그다음 메시지");
    await vi.waitFor(() => expect(decisions).toBe(2));
    expect(activeRequest?.signal?.aborted).toBe(false);
    expect(steer).not.toHaveBeenCalled();
  });

  it("keeps intake moving while a response is blocked and uses the model to cancel natural language", async () => {
    const pending = Promise.withResolvers<AgentRunResult>();
    let response: AgentRunRequest | undefined;
    const run = vi.fn<AgentRunner["run"]>(async (request) => {
      if (request.traceLabel === "stay_decision") return stayReply(request, "cancel");
      response = request;
      return waitForResult(request, pending.promise);
    });
    const fixture = await streamFixture(run);
    await fixture.publish("날씨 알려줘", { mention: true });
    await vi.waitFor(() => expect(response).toBeDefined());

    await fixture.publish("고마워, 이제 충분히 알겠어");
    await vi.waitFor(() => expect(response?.signal?.aborted).toBe(true));

    expect(fixture.discord.sentMessages).toEqual([]);
    expect(run.mock.calls.filter(([request]) => request.traceLabel === "response")).toHaveLength(1);
  });

  it("does not call a model or steer for other people's continuous chatter during a response", async () => {
    const pending = Promise.withResolvers<AgentRunResult>();
    const steer = vi.fn(() => true);
    const run = vi.fn<AgentRunner["run"]>(async (request) => {
      request.onControlReady?.({ steer });
      return waitForResult(request, pending.promise);
    });
    const fixture = await streamFixture(run);
    await fixture.publish("질문", { mention: true });
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    for (let index = 0; index < 12; index++)
      await fixture.publish(`사람끼리 하는 이야기 ${index}`, { otherAuthor: true });
    expect(run).toHaveBeenCalledTimes(1);
    expect(steer).not.toHaveBeenCalled();
    pending.resolve({ text: "답변" });
    await vi.waitFor(() =>
      expect(fixture.discord.sentMessages.map((message) => message.content)).toContain("답변"),
    );
  });

  it("lets the model distinguish a human-directed 'stop' from a cancellation", async () => {
    const pending = Promise.withResolvers<AgentRunResult>();
    let response: AgentRunRequest | undefined;
    const run = vi.fn<AgentRunner["run"]>(async (request) => {
      if (request.traceLabel === "stay_decision") return stayReply(request);
      response = request;
      return waitForResult(request, pending.promise);
    });
    const fixture = await streamFixture(run);
    await fixture.publish("질문", { mention: true });
    await vi.waitFor(() => expect(response).toBeDefined());
    await fixture.publish("그만 좀 해ㅋㅋ", { replyToHuman: true });
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(response?.signal?.aborted).toBe(false);
    pending.resolve({ text: "원래 질문의 답변" });
    await vi.waitFor(() => expect(fixture.discord.sentMessages).toHaveLength(1));
  });

  it("steers only model-selected corrections once and handles later corrections after the answer", async () => {
    const pending = Promise.withResolvers<AgentRunResult>();
    const steer = vi.fn(() => true);
    let responses = 0;
    let decisions = 0;
    const run = vi.fn<AgentRunner["run"]>(async (request) => {
      if (request.traceLabel === "stay_decision") {
        decisions += 1;
        const incoming = incomingSchema.parse(blockValue(request, "incoming_message_ids"));
        if (decisions <= 2) return stayReply(request, "update", { action: "reply" });
        return {
          text: JSON.stringify({
            stayEngaged: true,
            action: "reply",
            confidence: 1,
            reason: "follow up",
            attention: "directed_at_bot",
            targetMessageIds: incoming,
            replyPriority: "normal",
          }),
        };
      }
      responses += 1;
      request.onControlReady?.({ steer });
      return responses === 1 ? waitForResult(request, pending.promise) : { text: "후속 정정 반영" };
    });
    const fixture = await streamFixture(run);
    await fixture.publish("서울 날씨", { mention: true });
    await vi.waitFor(() => expect(responses).toBe(1));
    await fixture.publish("아니 부산 기준");
    await vi.waitFor(() => expect(steer).toHaveBeenCalledTimes(1));
    expect(steer.mock.calls[0]).toEqual([expect.stringContaining("아니 부산 기준")]);
    await fixture.publish("그리고 내일 기준으로");
    await vi.waitFor(() => expect(decisions).toBe(2));
    expect(responses).toBe(1);
    expect(steer).toHaveBeenCalledTimes(1);
    pending.resolve({ text: "부산 날씨" });
    await vi.waitFor(() =>
      expect(fixture.discord.sentMessages.map((message) => message.content)).toEqual([
        "부산 날씨",
        "후속 정정 반영",
      ]),
    );
    expect(responses).toBe(2);
  });

  it("freezes decision inputs and preserves every message received while that decision is blocked", async () => {
    const reply = Promise.withResolvers<AgentRunResult>();
    const decision = Promise.withResolvers<AgentRunResult>();
    const requests: AgentRunRequest[] = [];
    const run = vi.fn<AgentRunner["run"]>(async (request) => {
      if (request.traceLabel !== "stay_decision") return waitForResult(request, reply.promise);
      requests.push(request);
      return requests.length === 1 ? decision.promise : stayReply(request);
    });
    const fixture = await streamFixture(run, { maxRecentMessages: 2 });
    await fixture.publish("질문", { mention: true });
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    const first = await fixture.publish("추가 정보");
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    const newIds: string[] = [];
    for (let index = 0; index < 8; index++) {
      const event = await fixture.publish(`도착한 새 메시지 ${index}`);
      newIds.push(event.messageId);
    }
    expect(incomingSchema.parse(blockValue(requests[0] ?? failRequest(), "incoming_message_ids"))).toEqual([
      first.messageId,
    ]);
    decision.resolve(stayReply(requests[0] ?? failRequest()));
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(incomingSchema.parse(blockValue(requests[1] ?? failRequest(), "incoming_message_ids"))).toEqual(
      newIds,
    );
    expect(requests[1]?.messages.map((message) => message.content).join("\n")).toContain(
      "도착한 새 메시지 7",
    );
  });

  it("ignores late cancellation decisions after the response they observed has finished", async () => {
    const reply = Promise.withResolvers<AgentRunResult>();
    const decision = Promise.withResolvers<AgentRunResult>();
    let controlRequest: AgentRunRequest | undefined;
    const run = vi.fn<AgentRunner["run"]>(async (request) => {
      if (request.traceLabel === "stay_decision") {
        controlRequest = request;
        return decision.promise;
      }
      return waitForResult(request, reply.promise);
    });
    const fixture = await streamFixture(run);
    await fixture.publish("질문", { mention: true });
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    await fixture.publish("이제 충분해");
    await vi.waitFor(() => expect(controlRequest).toBeDefined());
    reply.resolve({ text: "완료된 답변" });
    await vi.waitFor(() => expect(fixture.discord.sentMessages).toHaveLength(1));
    decision.resolve(stayReply(controlRequest ?? failRequest(), "cancel"));
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(fixture.discord.sentMessages[0]?.content).toBe("완료된 답변");
    expect(run.mock.calls[0]?.[0].signal?.aborted).toBe(false);
  });

  it("bounds batching time even when messages keep arriving", async () => {
    vi.useFakeTimers();
    const reply = Promise.withResolvers<AgentRunResult>();
    let decisions = 0;
    const run = vi.fn<AgentRunner["run"]>(async (request) => {
      if (request.traceLabel === "stay_decision") {
        decisions += 1;
        return stayReply(request);
      }
      return waitForResult(request, reply.promise);
    });
    const fixture = await streamFixture(run, { debounceMs: 100, maxMessages: 1000, maxWaitMs: 150 });
    await fixture.publish("질문", { mention: true });
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    await fixture.publish("추가 정보 1");
    await vi.advanceTimersByTimeAsync(50);
    await fixture.publish("추가 정보 2");
    await vi.advanceTimersByTimeAsync(50);
    await fixture.publish("추가 정보 3");
    expect(decisions).toBe(0);
    await vi.advanceTimersByTimeAsync(50);
    await vi.waitFor(() => expect(decisions).toBe(1));
  });

  it("does not pull a different channel's conversation into the response context", async () => {
    const run = vi.fn<AgentRunner["run"]>().mockResolvedValue({ text: "답변" });
    const fixture = await streamFixture(run);
    await fixture.log.append(
      createMessageEvent(
        createMessage("private", { channelId: "private-channel", cleanContent: "비공개 대화" }),
      ),
    );
    await fixture.publish("질문", { mention: true });
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(run.mock.calls[0]?.[0].messages.map((message) => message.content).join("\n")).not.toContain(
      "비공개 대화",
    );
  });
});

function failRequest(): never {
  throw new Error("Expected an agent request.");
}
