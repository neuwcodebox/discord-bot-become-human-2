import type { Message } from "discord.js";
import { buildResponseContext } from "../agent/context-builder.js";
import type { AgentRunner } from "../agent/runner.js";
import { AttachmentCache } from "../discord/attachment-cache.js";
import { DiscordStreamingWriter } from "../discord/streaming-writer.js";
import { childLogger } from "../logger.js";
import { MemoryCompactor } from "../memory/compactor.js";
import { DreamScheduler } from "../memory/dream-scheduler.js";
import { EventLog } from "../memory/event-log.js";
import { createDiscordActionRuntimeFromMessage } from "../tools/discord-actions.js";
import { createToolRegistry } from "../tools/tool-registry.js";
import type {
  AppConfig,
  GuildWorkspace,
  NormalizedDiscordEvent,
  NormalizedDiscordMessage,
} from "../types.js";
import { delay, randomDebounceMs } from "./debounce.js";
import { decideEngagement, directEngagementDecision } from "./engagement-decision.js";
import {
  appendFollowUpMessage,
  computeFollowUpFlushDelayMs,
  shouldFlushByMessageCount,
} from "./follow-up-batch.js";
import { checkReplyHardGates, isDirectedAtBot, noteBotReply, noteHumanMessage } from "./reply-cadence.js";
import { ConversationStateStore, conversationId } from "./state-store.js";
import { decideStay, forcedSilentStay } from "./stay-decision.js";

const log = childLogger("conversation");

export class ConversationOrchestrator {
  private readonly states = new ConversationStateStore();
  private readonly attachmentCache = new AttachmentCache();
  private readonly dreamScheduler: DreamScheduler;

  constructor(
    private readonly config: AppConfig,
    private readonly agentsPath: string,
    private readonly runner: AgentRunner,
    private readonly botIdentity: { userId?: string; names: string[] } = { names: [] },
  ) {
    this.dreamScheduler = new DreamScheduler(config, agentsPath, runner);
  }

  async onMessage(
    event: Extract<NormalizedDiscordEvent, { type: "message_create" }>,
    workspace: GuildWorkspace,
    discordMessage?: Message<boolean>,
  ): Promise<void> {
    const message = event.payload;
    this.attachmentCache.remember(message);
    const id = conversationId(message);
    const state = this.states.get(id);
    if (message.author.isBot) {
      log.debug(
        { guildId: event.guildId, channelId: event.channelId, messageId: event.messageId },
        "bot-authored message ignored",
      );
      return;
    }

    const relatedToBot = this.isStrongTrigger(message);
    const previousLastHumanAt = state.lastHumanMessageAt;
    noteHumanMessage(state, relatedToBot);
    log.debug(
      {
        guildId: event.guildId,
        channelId: event.channelId,
        messageId: event.messageId,
        conversationId: id,
        engagement: state.engagement,
        relatedToBot,
      },
      "conversation message received",
    );
    this.dreamScheduler.startForGuild(workspace);
    const compacted = await new MemoryCompactor(workspace.workspaceRoot, this.config).compactIfNeeded();
    if (compacted && this.config.memory.dream.runOnCompaction) {
      log.info({ guildId: workspace.guildId, reason: "compaction" }, "dream run triggered");
      await this.dreamScheduler.runNow(workspace, "compaction");
    }
    const events = await new EventLog(workspace.workspaceRoot).readRecent(
      this.config.conversation.maxRecentMessages,
    );

    if (state.engagement === "not_engaged") {
      const decision = relatedToBot
        ? directEngagementDecision(message, "direct trigger")
        : await this.maybeAmbientEngage(workspace.workspaceRoot, state, events, message, previousLastHumanAt);
      if (!decision?.engage) {
        log.debug(
          { guildId: workspace.guildId, channelId: event.channelId, messageId: event.messageId },
          "message did not engage bot",
        );
        return;
      }
      state.engagement = "engaged";
      state.engagedSince = new Date().toISOString();
      state.lastEngagementChangedAt = state.engagedSince;
      log.info(
        {
          guildId: workspace.guildId,
          channelId: event.channelId,
          messageId: event.messageId,
          confidence: decision.confidence,
          expectedRole: decision.expectedRole,
        },
        "conversation engaged",
      );
      await delay(randomDebounceMs(this.config.conversation.notEngaged.engageDebounceMs));
      await this.reply(decision, events, workspace, discordMessage);
      return;
    }

    if (shouldIdleDisengage(this.config, state)) {
      this.clearPendingFollowUp(state);
      state.engagement = "not_engaged";
      state.lastEngagementChangedAt = new Date().toISOString();
      log.info(
        { guildId: workspace.guildId, channelId: event.channelId, messageId: event.messageId },
        "conversation disengaged by idle/unrelated gate",
      );
      return;
    }

    await this.queueEngagedFollowUp({
      conversationKey: id,
      state,
      workspace,
      discordMessage,
      message,
      relatedToBot,
    });
  }

  private async queueEngagedFollowUp(input: {
    conversationKey: string;
    state: ReturnType<ConversationStateStore["get"]>;
    workspace: GuildWorkspace;
    discordMessage?: Message<boolean> | undefined;
    message: NormalizedDiscordMessage;
    relatedToBot: boolean;
  }): Promise<void> {
    const now = new Date();
    const batch = appendFollowUpMessage({
      batch: input.state.pendingFollowUp,
      messageId: input.message.id,
      relatedToBot: input.relatedToBot,
      now,
    });
    input.state.pendingFollowUp = batch;
    if (input.state.pendingTimer) clearTimeout(input.state.pendingTimer);

    const config = this.config.conversation.engaged.followUpBatch;
    const flushByCount = shouldFlushByMessageCount(batch, config);
    const debounceMs = randomDebounceMs(
      batch.relatedToBot ? config.directTriggerDebounceMs : config.quietDebounceMs,
    );
    const delayMs = flushByCount
      ? 0
      : computeFollowUpFlushDelayMs({
          batch,
          config,
          state: input.state,
          nowMs: now.getTime(),
          debounceMs,
        });
    log.info(
      {
        guildId: input.workspace.guildId,
        channelId: input.message.channelId,
        messageId: input.message.id,
        pendingMessageIds: batch.messageIds,
        pendingCount: batch.messageIds.length,
        relatedToBot: batch.relatedToBot,
        delayMs,
        flushByCount,
      },
      "engaged follow-up queued",
    );

    if (delayMs === 0) {
      await this.flushEngagedFollowUp(input.conversationKey, input.workspace, input.discordMessage);
      return;
    }

    input.state.pendingTimer = setTimeout(() => {
      void this.flushEngagedFollowUp(input.conversationKey, input.workspace, input.discordMessage).catch(
        (error) => {
          log.error(
            { err: error, guildId: input.workspace.guildId, channelId: input.message.channelId },
            "engaged follow-up flush failed",
          );
        },
      );
    }, delayMs);
    input.state.pendingTimer.unref();
  }

  private async flushEngagedFollowUp(
    conversationKey: string,
    workspace: GuildWorkspace,
    discordMessage?: Message<boolean>,
  ): Promise<void> {
    const state = this.states.get(conversationKey);
    const batch = state.pendingFollowUp;
    if (!batch) return;
    this.clearPendingFollowUp(state);
    if (state.engagement !== "engaged") return;
    if (!discordMessage) {
      log.warn({ guildId: workspace.guildId }, "engaged follow-up flush skipped without discord message");
      return;
    }

    const events = await new EventLog(workspace.workspaceRoot).readRecent(
      this.config.conversation.maxRecentMessages,
    );
    const currentMessage = findMessageById(events, batch.messageIds.at(-1));
    if (!currentMessage) {
      log.warn(
        {
          guildId: workspace.guildId,
          channelId: discordMessage.channelId,
          pendingMessageIds: batch.messageIds,
        },
        "engaged follow-up flush skipped because latest message is missing from event log",
      );
      return;
    }

    log.info(
      {
        guildId: workspace.guildId,
        channelId: discordMessage.channelId,
        pendingMessageIds: batch.messageIds,
        pendingCount: batch.messageIds.length,
        relatedToBot: batch.relatedToBot,
      },
      "engaged follow-up flushing",
    );
    const gate = checkReplyHardGates(this.config, state, currentMessage, {
      unprompted: false,
      allowDuringCooldown: true,
      allowBeforeMinReplyInterval: true,
      botUserId: this.botIdentity.userId,
      botNames: this.botIdentity.names,
    });
    const stay = gate.allowed
      ? await decideStay({
          runner: this.runner,
          agentsPath: this.agentsPath,
          workspaceRoot: workspace.workspaceRoot,
          state,
          events,
          currentMessage,
        })
      : forcedSilentStay(gate.reason, currentMessage.id);
    log.info(
      {
        guildId: workspace.guildId,
        channelId: discordMessage.channelId,
        pendingMessageIds: batch.messageIds,
        action: stay.action,
        confidence: stay.confidence,
        reason: stay.reason,
      },
      "engaged follow-up stay decided",
    );
    if (!stay.stayEngaged || stay.action === "disengage") {
      this.clearPendingFollowUp(state);
      state.engagement = "not_engaged";
      state.lastEngagementChangedAt = new Date().toISOString();
      log.info(
        {
          guildId: workspace.guildId,
          channelId: discordMessage.channelId,
          messageId: currentMessage.id,
          action: stay.action,
          reason: stay.reason,
          confidence: stay.confidence,
        },
        "conversation disengaged by stay decision",
      );
      return;
    }
    if (
      stay.action !== "reply" ||
      stay.confidence < this.config.conversation.engaged.replyConfidenceThreshold
    ) {
      log.info(
        {
          guildId: workspace.guildId,
          channelId: discordMessage.channelId,
          messageId: currentMessage.id,
          action: stay.action,
          confidence: stay.confidence,
          reason: stay.reason,
        },
        "engaged conversation stayed silent",
      );
      return;
    }
    await this.reply(stay, events, workspace, discordMessage);
  }

  private clearPendingFollowUp(state: ReturnType<ConversationStateStore["get"]>): void {
    if (state.pendingTimer) clearTimeout(state.pendingTimer);
    delete state.pendingTimer;
    delete state.pendingFollowUp;
  }

  private async maybeAmbientEngage(
    workspaceRoot: string,
    state: ReturnType<ConversationStateStore["get"]>,
    events: NormalizedDiscordEvent[],
    message: NormalizedDiscordMessage,
    previousLastHumanAt?: string,
  ) {
    if (!this.config.conversation.notEngaged.ambientEngagementEnabled) {
      log.debug({ messageId: message.id }, "ambient engagement disabled");
      return undefined;
    }
    const now = Date.now();
    const lastHumanAt = previousLastHumanAt ? Date.parse(previousLastHumanAt) : 0;
    if (lastHumanAt && now - lastHumanAt < this.config.conversation.notEngaged.ambientMinSilenceMs) {
      log.debug({ messageId: message.id }, "ambient engagement skipped by silence window");
      return undefined;
    }
    state.ambientReplyTimes = state.ambientReplyTimes.filter(
      (time) => now - Date.parse(time) < 60 * 60 * 1000,
    );
    if (state.ambientReplyTimes.length >= this.config.conversation.notEngaged.ambientMaxPerHour) {
      log.debug({ messageId: message.id }, "ambient engagement skipped by hourly limit");
      return undefined;
    }
    const decision = await decideEngagement({
      runner: this.runner,
      agentsPath: this.agentsPath,
      workspaceRoot,
      state,
      events,
      currentMessage: message,
    });
    if (decision.confidence < this.config.conversation.notEngaged.ambientConfidenceThreshold) {
      log.debug(
        { messageId: message.id, confidence: decision.confidence },
        "ambient engagement below confidence threshold",
      );
      return undefined;
    }
    state.ambientReplyTimes.push(new Date().toISOString());
    return decision;
  }

  private async reply(
    task: Parameters<typeof buildResponseContext>[0]["task"],
    events: NormalizedDiscordEvent[],
    workspace: GuildWorkspace,
    discordMessage?: Message<boolean>,
  ): Promise<void> {
    if (!discordMessage) {
      log.warn({ guildId: workspace.guildId }, "reply skipped because discord message is unavailable");
      return;
    }
    const startedAt = Date.now();
    const state = this.states.get(conversationId(taskMessageKey(events)));
    log.info(
      {
        guildId: workspace.guildId,
        channelId: discordMessage.channelId,
        targetMessageIds: task.targetMessageIds,
        action: "reply",
      },
      "agent reply started",
    );
    const context = await buildResponseContext({
      agentsPath: this.agentsPath,
      workspaceRoot: workspace.workspaceRoot,
      config: this.config,
      events,
      targetMessageIds: task.targetMessageIds,
      task,
    });
    const toolContext = {
      guildId: workspace.guildId,
      workspaceRoot: workspace.workspaceRoot,
      channelId: discordMessage.channelId,
      actorUserId: discordMessage.author.id,
    };
    const tools = createToolRegistry(this.config, toolContext, {
      attachmentCache: this.attachmentCache,
      discordActions: createDiscordActionRuntimeFromMessage(discordMessage, toolContext),
    });
    if (this.config.streaming.enabled && this.config.discord.enableMessageEditStreaming) {
      const writer = new DiscordStreamingWriter(discordMessage.channel, this.config, discordMessage);
      await writer.start();
      const result = await this.runner.run({
        sessionId: `discord:${workspace.guildId}:${discordMessage.channelId}`,
        messages: context,
        tools,
        onTextDelta: (delta) => writer.append(delta),
      });
      const sent = await writer.finish(result.text);
      if (sent) noteBotReply(this.config, state, sent.id);
      log.info(
        {
          guildId: workspace.guildId,
          channelId: discordMessage.channelId,
          messageId: sent?.id,
          streaming: true,
          durationMs: Date.now() - startedAt,
          outputLength: result.text.length,
        },
        "agent reply completed",
      );
    } else {
      const result = await this.runner.run({
        sessionId: `discord:${workspace.guildId}:${discordMessage.channelId}`,
        messages: context,
        tools,
      });
      const sent = await discordMessage.reply({
        content: result.text,
        allowedMentions: { parse: [], repliedUser: false },
      });
      noteBotReply(this.config, state, sent.id);
      log.info(
        {
          guildId: workspace.guildId,
          channelId: discordMessage.channelId,
          messageId: sent.id,
          streaming: false,
          durationMs: Date.now() - startedAt,
          outputLength: result.text.length,
        },
        "agent reply completed",
      );
    }
  }

  private isStrongTrigger(message: NormalizedDiscordMessage): boolean {
    if (isDirectedAtBot(message, this.botIdentity.userId, this.botIdentity.names)) return true;
    if (message.replyTo && this.botIdentity.userId && message.replyTo.authorId === this.botIdentity.userId)
      return true;
    return /^\/[a-z0-9_-]+/i.test(message.cleanContent.trim());
  }
}

function shouldIdleDisengage(config: AppConfig, state: ReturnType<ConversationStateStore["get"]>): boolean {
  if (
    state.unrelatedHumanMessagesSinceLastBot >=
    config.conversation.engaged.disengageAfterUnrelatedHumanMessages
  ) {
    return true;
  }
  if (!state.lastHumanMessageAt) return false;
  return (
    Date.now() - Date.parse(state.lastHumanMessageAt) >= config.conversation.engaged.disengageAfterIdleMs
  );
}

function findMessageById(
  events: NormalizedDiscordEvent[],
  messageId: string | undefined,
): NormalizedDiscordMessage | undefined {
  if (!messageId) return undefined;
  return [...events]
    .reverse()
    .find(
      (event): event is Extract<NormalizedDiscordEvent, { type: "message_create" | "message_update" }> =>
        (event.type === "message_create" || event.type === "message_update") && event.messageId === messageId,
    )?.payload;
}

function taskMessageKey(events: NormalizedDiscordEvent[]): {
  guildId: string;
  channelId: string;
  threadId?: string;
} {
  const latest = [...events]
    .reverse()
    .find((event) => event.type === "message_create" || event.type === "message_update");
  if (!latest) return { guildId: "unknown", channelId: "unknown" };
  return {
    guildId: latest.guildId,
    channelId: latest.channelId,
    ...(latest.threadId ? { threadId: latest.threadId } : {}),
  };
}
