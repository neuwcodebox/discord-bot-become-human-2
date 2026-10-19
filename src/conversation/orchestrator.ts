import { randomUUID } from "node:crypto";
import type { Message } from "discord.js";
import type { AgentRunner } from "../agent/runner.js";
import { truncateText } from "../context/limits.js";
import { AttachmentCache } from "../discord/attachment-cache.js";
import { childLogger } from "../logger.js";
import { buildCompactionSummaryContext, MemoryCompactor } from "../memory/compactor.js";
import { DreamRunner } from "../memory/dream-runner.js";
import { DreamScheduler } from "../memory/dream-scheduler.js";
import { EventLog } from "../memory/event-log.js";
import type {
  ActiveResponseSnapshot,
  AgentRunControl,
  AppConfig,
  BotIdentity,
  ConversationRuntimeState,
  EngagementDecision,
  GuildWorkspace,
  HistoryEntry,
  NormalizedDiscordEvent,
  NormalizedDiscordMessage,
  StayDecision,
} from "../types.js";
import { randomDebounceMs } from "./debounce.js";
import { decideEngagement, directEngagementDecision } from "./engagement-decision.js";
import {
  appendFollowUpMessage,
  computeFollowUpFlushDelayMs,
  shouldFlushByMessageCount,
} from "./follow-up-batch.js";
import {
  checkReplyHardGates,
  isDirectedAtBot,
  noteBotReply,
  noteHumanMessage,
  type ReplyGateResult,
} from "./reply-cadence.js";
import { ConversationResponder } from "./responder.js";
import { ConversationStateStore, conversationId } from "./state-store.js";
import { decideStay, forcedSilentStay } from "./stay-decision.js";
import { buildTranscript, materializeMessages } from "./transcript-builder.js";

const log = childLogger("conversation");
type MessageEvent = Extract<NormalizedDiscordEvent, { type: "message_create" }>;
type ReceivedMessage = {
  sequence: number;
  receivedAt: string;
  event: MessageEvent;
  discordMessage?: Message<boolean>;
  previousLastHumanAt?: string;
  directedByModel?: boolean;
};
type ActiveResponse = ActiveResponseSnapshot & {
  controller: AbortController;
  control: AgentRunControl | undefined;
  pendingSteering: string | undefined;
};
type ConversationStream = {
  workspace: GuildWorkspace;
  state: ConversationRuntimeState;
  receivedSequence: number;
  decidedSequence: number;
  pending: ReceivedMessage[];
  deferred: ReceivedMessage[];
  deciding: boolean;
  decisionController: AbortController | undefined;
  waitCount: number;
  active: ActiveResponse | undefined;
};

export class ConversationOrchestrator {
  private readonly states = new ConversationStateStore();
  private readonly streams = new Map<string, ConversationStream>();
  private readonly maintenance = new Map<string, Promise<void>>();
  private readonly attachmentCache = new AttachmentCache();
  private readonly dreamScheduler: DreamScheduler;
  private readonly responder: ConversationResponder;
  private closed = false;

  constructor(
    private readonly config: AppConfig,
    private readonly agentsPath: string,
    private readonly runner: AgentRunner,
    private readonly botIdentity: BotIdentity,
  ) {
    this.dreamScheduler = new DreamScheduler(config, agentsPath, runner);
    this.responder = new ConversationResponder(config, agentsPath, runner, botIdentity, this.attachmentCache);
  }

  /** Intake never waits for a model, a response, or memory maintenance. */
  async onMessage(
    event: MessageEvent,
    workspace: GuildWorkspace,
    discordMessage?: Message<boolean>,
  ): Promise<void> {
    this.attachmentCache.remember(event.payload);
    if (this.closed || event.payload.author.isBot || this.runner.isAvailable?.() === false) return;
    const id = conversationId(event.payload);
    let stream = this.streams.get(id);
    if (!stream) {
      stream = {
        workspace,
        state: this.states.get(id),
        receivedSequence: 0,
        decidedSequence: 0,
        pending: [],
        deferred: [],
        deciding: false,
        decisionController: undefined,
        waitCount: 0,
        active: undefined,
      };
      this.streams.set(id, stream);
    }
    const previousLastHumanAt = stream.state.lastHumanMessageAt;
    noteHumanMessage(stream.state, this.isStrongTrigger(event.payload));
    stream.pending.push({
      sequence: ++stream.receivedSequence,
      receivedAt: new Date().toISOString(),
      event,
      ...(discordMessage ? { discordMessage } : {}),
      ...(previousLastHumanAt ? { previousLastHumanAt } : {}),
    });
    if (stream.pending.length === 1 && !stream.deciding) stream.waitCount = 0;
    this.dreamScheduler.startForGuild(workspace);
    this.startMaintenance(workspace);
    this.schedule(stream);
  }

  dispose(): void {
    this.closed = true;
    this.dreamScheduler.stopAll();
    for (const stream of this.streams.values()) {
      this.clearTimer(stream.state);
      stream.decisionController?.abort();
      stream.active?.controller.abort();
    }
  }

  pause(): void {
    for (const stream of this.streams.values()) {
      this.clearTimer(stream.state);
      stream.pending = [];
      stream.deferred = [];
      stream.waitCount = 0;
      delete stream.state.pendingFollowUp;
      stream.state.engagement = "not_engaged";
      stream.decisionController?.abort();
      stream.active?.controller.abort();
    }
  }

  private explicitAddress(message: NormalizedDiscordMessage): boolean {
    return (
      message.mentions.some((mention) => mention.id === this.botIdentity.userId) ||
      message.replyTo?.authorId === this.botIdentity.userId
    );
  }

  private canAddressActive(input: ReceivedMessage, active: ActiveResponseSnapshot): boolean {
    return (
      active.requesterIds.includes(input.event.payload.author.id) || this.explicitAddress(input.event.payload)
    );
  }

  private isDirectedInput(input: ReceivedMessage): boolean {
    return input.directedByModel === true || this.isStrongTrigger(input.event.payload);
  }

  private schedule(stream: ConversationStream): void {
    if (this.closed || stream.deciding || stream.pending.length === 0) return;
    this.clearTimer(stream.state);
    const active = stream.active;
    if (active?.controller.signal.aborted) return;
    if (active && !stream.pending.some((input) => this.canAddressActive(input, active))) return;
    const first = stream.pending[0];
    if (!first) return;
    let batch = appendFollowUpMessage({
      messageId: first.event.messageId,
      relatedToBot: this.isDirectedInput(first),
      now: new Date(first.receivedAt),
    });
    for (const input of stream.pending.slice(1)) {
      batch = appendFollowUpMessage({
        batch,
        messageId: input.event.messageId,
        relatedToBot: this.isDirectedInput(input),
        now: new Date(input.receivedAt),
      });
    }
    if (active) batch.relatedToBot = true;
    batch.waitCount = stream.waitCount;
    stream.state.pendingFollowUp = batch;
    const followUp = this.config.conversation.engaged.followUpBatch;
    const initial = stream.state.engagement === "not_engaged" && !active;
    const range = initial
      ? batch.relatedToBot
        ? this.config.conversation.notEngaged.directTriggerDebounceMs
        : this.config.conversation.notEngaged.ambientDebounceMs
      : batch.relatedToBot
        ? followUp.directTriggerDebounceMs
        : followUp.quietDebounceMs;
    const delayMs = shouldFlushByMessageCount(batch, followUp)
      ? 0
      : computeFollowUpFlushDelayMs({
          batch,
          config: followUp,
          state: stream.state,
          nowMs: Date.now(),
          debounceMs: randomDebounceMs(range),
        });
    stream.state.pendingTimer = setTimeout(() => {
      void this.drain(stream);
    }, delayMs);
    stream.state.pendingTimer.unref();
  }

  private async drain(stream: ConversationStream): Promise<void> {
    if (this.runner.isAvailable?.() === false) {
      this.pause();
      return;
    }
    if (this.closed || stream.deciding || stream.pending.length === 0) return;
    this.clearTimer(stream.state);
    let batch = stream.pending;
    const lastSequence = batch.at(-1)?.sequence ?? 0;
    stream.pending = [];
    delete stream.state.pendingFollowUp;
    stream.deciding = true;
    const decisionController = new AbortController();
    stream.decisionController = decisionController;
    const activeAtStart = stream.active ? snapshotActive(stream.active) : undefined;
    let waiting = false;
    const stateAtStart = {
      ...stream.state,
      recentBotMessageIds: [...stream.state.recentBotMessageIds],
      ambientReplyTimes: [...stream.state.ambientReplyTimes],
    };
    try {
      const events = await this.readSnapshot(stream, batch);
      const latestMessages = new Map(materializeMessages(events).map((message) => [message.id, message]));
      batch = batch.flatMap((input) => {
        const message = latestMessages.get(input.event.messageId);
        if (message && !message.deletedAt) this.attachmentCache.remember(message);
        return message && !message.deletedAt
          ? [{ ...input, event: { ...input.event, payload: message } }]
          : [];
      });
      const current = batch.at(-1);
      if (!current || this.closed) return;
      const incomingMessageIds = batch.map((input) => input.event.messageId);
      if (stateAtStart.engagement === "not_engaged" && !activeAtStart) {
        const direct = batch.findLast((input) => this.isDirectedInput(input));
        const decision = direct
          ? {
              ...directEngagementDecision(direct.event.payload, "direct trigger"),
              targetMessageIds: batch
                .filter(
                  (input) =>
                    this.isDirectedInput(input) ||
                    input.event.payload.author.id === direct.event.payload.author.id,
                )
                .map((input) => input.event.messageId),
            }
          : await this.maybeAmbientEngage(
              stream.workspace.workspaceRoot,
              stream.state,
              events,
              current.event.payload,
              batch[0]?.previousLastHumanAt,
              decisionController.signal,
            );
        if (this.closed || !decision?.engage) return;
        stream.state.engagement = "engaged";
        stream.state.engagedSince = new Date().toISOString();
        stream.state.lastEngagementChangedAt = stream.state.engagedSince;
        this.startResponse(stream, decision, events, batch);
        return;
      }
      if (
        !activeAtStart &&
        !batch.some((input) => this.isDirectedInput(input)) &&
        shouldIdleDisengage(this.config, stateAtStart)
      ) {
        stream.state.engagement = "not_engaged";
        stream.state.lastEngagementChangedAt = new Date().toISOString();
        return;
      }
      const gate: ReplyGateResult = activeAtStart
        ? { allowed: true }
        : checkReplyHardGates(this.config, stateAtStart, current.event.payload, {
            unprompted: false,
            allowDuringCooldown: true,
            allowBeforeMinReplyInterval: true,
            botUserId: this.botIdentity.userId,
            botNames: this.botIdentity.names,
          });
      let stay = gate.allowed
        ? await decideStay({
            runner: this.runner,
            agentsPath: this.agentsPath,
            workspaceRoot: stream.workspace.workspaceRoot,
            state: stateAtStart,
            events,
            currentMessage: current.event.payload,
            incomingMessageIds,
            timezone: this.config.runtime.timezone,
            botIdentity: this.botIdentity,
            signal: decisionController.signal,
            ...(activeAtStart ? { activeResponse: activeAtStart } : {}),
          })
        : forcedSilentStay(gate.reason, current.event.messageId);
      if (this.closed) return;
      stay = {
        ...stay,
        targetMessageIds: stay.targetMessageIds.filter((id) => incomingMessageIds.includes(id)),
      };
      log.info(
        {
          guildId: stream.workspace.guildId,
          channelId: current.event.channelId,
          firstSequence: batch[0]?.sequence,
          lastSequence: current.sequence,
          pendingCount: batch.length,
          action: stay.action,
          confidence: stay.confidence,
          responseControl: stay.responseControl?.action,
        },
        "stream batch decided",
      );
      if (stay.confidence >= this.config.conversation.engaged.replyConfidenceThreshold && activeAtStart) {
        const result = this.applyResponseControl(stream, activeAtStart, stay, batch, events);
        if (result === "cancelled") {
          if (stay.action === "reply") {
            this.deferResponse(
              stream,
              batch,
              stay.targetMessageIds.filter((id) => !stay.responseControl?.messageIds.includes(id)),
            );
          }
          return;
        }
        if (result === "updated") {
          stay = {
            ...stay,
            targetMessageIds: stay.targetMessageIds.filter(
              (id) => !stay.responseControl?.messageIds.includes(id),
            ),
          };
          if (stay.action !== "reply" || stay.targetMessageIds.length === 0) return;
        }
        if (result === "follow_up") {
          stay = {
            ...stay,
            action: "reply",
            stayEngaged: true,
            targetMessageIds:
              stay.responseControl?.messageIds.filter((id) => incomingMessageIds.includes(id)) ?? [],
          };
        }
      }
      if (stay.action === "disengage" || (!stay.stayEngaged && stay.action !== "react")) {
        if (!stream.active) {
          stream.state.engagement = "not_engaged";
          stream.state.lastEngagementChangedAt = new Date().toISOString();
        }
        return;
      }
      if (stay.action === "wait" && stream.waitCount < 1) {
        waiting = true;
        stream.waitCount += 1;
        stream.pending = mergeInputs(batch, stream.pending);
        return;
      }
      if (
        stay.action === "react" &&
        stay.confidence >= this.config.conversation.engaged.silentStayConfidenceThreshold
      ) {
        const target = batch.findLast((input) => stay.targetMessageIds.includes(input.event.messageId));
        if (target?.discordMessage)
          await this.responder.react(
            stay,
            events,
            stream.workspace,
            target.discordMessage,
            target.event.payload,
          );
        return;
      }
      if (
        stay.action !== "reply" ||
        stay.confidence < this.config.conversation.engaged.replyConfidenceThreshold ||
        stay.targetMessageIds.length === 0
      )
        return;
      if (stream.active) {
        this.deferResponse(stream, batch, stay.targetMessageIds);
      } else this.startResponse(stream, stay, events, batch);
    } catch (error) {
      if (!decisionController.signal.aborted)
        log.error({ err: error, guildId: stream.workspace.guildId }, "stream batch processing failed");
    } finally {
      stream.decidedSequence = Math.max(stream.decidedSequence, lastSequence);
      stream.deciding = false;
      stream.decisionController = undefined;
      if (!waiting) stream.waitCount = 0;
      this.schedule(stream);
    }
  }

  private deferResponse(stream: ConversationStream, batch: ReceivedMessage[], ids: string[]): void {
    stream.deferred = mergeInputs(
      stream.deferred,
      batch
        .filter((input) => ids.includes(input.event.messageId))
        .map((input) => ({ ...input, directedByModel: true })),
    );
  }

  private applyResponseControl(
    stream: ConversationStream,
    expected: ActiveResponseSnapshot,
    stay: StayDecision,
    batch: ReceivedMessage[],
    events: NormalizedDiscordEvent[],
  ): "ignored" | "updated" | "cancelled" | "follow_up" {
    const command = stay.responseControl;
    if (!command || command.action === "continue" || command.responseId !== expected.id) return "ignored";
    const evidence = batch.filter(
      (input) => command.messageIds.includes(input.event.messageId) && this.canAddressActive(input, expected),
    );
    if (evidence.length === 0 || evidence.length !== new Set(command.messageIds).size) return "ignored";
    const active = stream.active;
    if (!active || active.id !== expected.id || active.controller.signal.aborted)
      return command.action === "update" ? "follow_up" : "ignored";
    if (command.action === "cancel") {
      active.controller.abort();
      if (!stay.stayEngaged) stream.state.engagement = "not_engaged";
      return "cancelled";
    }
    if (active.updatesUsed >= 1) return "follow_up";
    const contents =
      "New observed Discord messages correct or add to the current task. Incorporate only what is relevant and finish your answer; do not repeat already sent text or expose internal control details.\n" +
      buildTranscript(
        events.filter((event) => evidence.some((input) => input.event.messageId === event.messageId)),
        {
          guildId: evidence[0]?.event.guildId ?? stream.workspace.guildId,
          channelId: evidence[0]?.event.channelId ?? "",
          targetMessageIds: evidence.map((input) => input.event.messageId),
          timezone: this.config.runtime.timezone,
          botUserId: this.botIdentity.userId,
        },
      );
    if (active.control && !active.control.steer(contents)) return "follow_up";
    if (!active.control) active.pendingSteering = contents;
    active.updatesUsed += 1;
    return "updated";
  }

  private startResponse(
    stream: ConversationStream,
    task: EngagementDecision | StayDecision,
    events: NormalizedDiscordEvent[],
    batch: ReceivedMessage[],
  ): void {
    if (this.closed || stream.active) return;
    const input = batch.findLast((item) => task.targetMessageIds.includes(item.event.messageId));
    if (!input?.discordMessage) return;
    const targets = materializeMessages(events).filter((message) =>
      task.targetMessageIds.includes(message.id),
    );
    const active: ActiveResponse = {
      id: randomUUID(),
      startedAt: new Date().toISOString(),
      requesterIds: [...new Set(targets.map((message) => message.author.id))],
      targetMessageIds: [...task.targetMessageIds],
      updatesUsed: 0,
      textPreview: "",
      requestMessages: targets.map((message) => ({
        id: message.id,
        authorId: message.author.id,
        text: truncateText(message.cleanContent, 2000).text,
      })),
      controller: new AbortController(),
      control: undefined,
      pendingSteering: undefined,
    };
    stream.active = active;
    const humansAtStart = stream.state.humanMessagesSinceLastBot;
    const unrelatedAtStart = stream.state.unrelatedHumanMessagesSinceLastBot;
    void this.responder
      .reply(task, events, stream.workspace, input.discordMessage, {
        signal: active.controller.signal,
        onProgress: (text) => {
          active.textPreview = truncateText(text, 1200).text;
        },
        onControlReady: (control) => {
          if (stream.active !== active || active.controller.signal.aborted) return;
          active.control = control;
          if (active.pendingSteering) {
            control.steer(active.pendingSteering);
            active.pendingSteering = undefined;
          }
        },
      })
      .then((messageId) => {
        if (stream.active !== active || !messageId) return;
        const newHumans = Math.max(0, stream.state.humanMessagesSinceLastBot - humansAtStart);
        const newUnrelated = Math.max(0, stream.state.unrelatedHumanMessagesSinceLastBot - unrelatedAtStart);
        noteBotReply(this.config, stream.state, messageId);
        stream.state.humanMessagesSinceLastBot = newHumans;
        stream.state.unrelatedHumanMessagesSinceLastBot = newUnrelated;
        if (stream.pending.length || stream.deferred.length) stream.state.consecutiveBotReplies = 0;
      })
      .catch((error) => {
        if (!active.controller.signal.aborted)
          log.error(
            { err: error, guildId: stream.workspace.guildId, responseId: active.id },
            "agent reply failed",
          );
      })
      .finally(() => {
        if (stream.active !== active) return;
        stream.active = undefined;
        stream.pending = mergeInputs(stream.deferred, stream.pending);
        stream.deferred = [];
        this.schedule(stream);
      });
  }

  /** Freeze the event log at decision start, including replies and edits since deferred input arrived. */
  private async readSnapshot(
    stream: ConversationStream,
    batch: ReceivedMessage[],
  ): Promise<NormalizedDiscordEvent[]> {
    const all = await new EventLog(stream.workspace.workspaceRoot).readAll();
    const latest = batch.at(-1);
    if (!latest) return [];
    const futureIds = new Set(
      stream.pending
        .filter((input) => input.sequence > latest.sequence)
        .map((input) => input.event.messageId),
    );
    const captured = all.filter(
      (event) => conversationId(event) === conversationId(latest.event) && !futureIds.has(event.messageId),
    );
    const existing = new Set(
      captured
        .filter(
          (event) =>
            event.type === "message_create" ||
            event.type === "message_update" ||
            event.type === "message_delete",
        )
        .map((event) => event.messageId),
    );
    captured.push(
      ...batch.filter((input) => !existing.has(input.event.messageId)).map((input) => input.event),
    );
    const newIds = new Set(batch.map((input) => input.event.messageId));
    const prior = captured
      .filter((event) => !newIds.has(event.messageId))
      .slice(-this.config.conversation.maxRecentMessages);
    return [...prior, ...captured.filter((event) => newIds.has(event.messageId))];
  }

  private clearTimer(state: ConversationRuntimeState): void {
    if (state.pendingTimer) clearTimeout(state.pendingTimer);
    delete state.pendingTimer;
  }

  private async maybeAmbientEngage(
    workspaceRoot: string,
    state: ConversationRuntimeState,
    events: NormalizedDiscordEvent[],
    message: NormalizedDiscordMessage,
    previousLastHumanAt?: string,
    signal?: AbortSignal,
  ) {
    if (!this.config.conversation.notEngaged.ambientEngagementEnabled) return undefined;
    const now = Date.now();
    const lastHumanAt = previousLastHumanAt ? Date.parse(previousLastHumanAt) : 0;
    if (lastHumanAt && now - lastHumanAt < this.config.conversation.notEngaged.ambientMinSilenceMs)
      return undefined;
    const lastDecisionAt = state.lastAmbientDecisionAt ? Date.parse(state.lastAmbientDecisionAt) : 0;
    if (
      lastDecisionAt &&
      now - lastDecisionAt < this.config.conversation.notEngaged.ambientDecisionCooldownMs
    )
      return undefined;
    state.ambientReplyTimes = state.ambientReplyTimes.filter((time) => now - Date.parse(time) < 3_600_000);
    if (state.ambientReplyTimes.length >= this.config.conversation.notEngaged.ambientMaxPerHour)
      return undefined;
    state.lastAmbientDecisionAt = new Date(now).toISOString();
    const decision = await decideEngagement({
      runner: this.runner,
      agentsPath: this.agentsPath,
      workspaceRoot,
      state: { ...state },
      events,
      currentMessage: message,
      timezone: this.config.runtime.timezone,
      botIdentity: this.botIdentity,
      ...(signal ? { signal } : {}),
    });
    if (decision.confidence < this.config.conversation.notEngaged.ambientConfidenceThreshold)
      return undefined;
    state.ambientReplyTimes.push(new Date().toISOString());
    return decision;
  }

  private isStrongTrigger(message: NormalizedDiscordMessage): boolean {
    return (
      this.explicitAddress(message) ||
      isDirectedAtBot(message, this.botIdentity.userId, this.botIdentity.names)
    );
  }

  private startMaintenance(workspace: GuildWorkspace): void {
    if (!this.config.memory.compaction.enabled || this.maintenance.has(workspace.guildId)) return;
    const pending = this.compact(workspace)
      .then(async (compacted) => {
        if (compacted && this.config.memory.dream.runOnCompaction && !this.closed)
          await this.dreamScheduler.runNow(workspace, "compaction");
      })
      .catch((error) => {
        log.error({ err: error, guildId: workspace.guildId }, "memory maintenance failed");
      })
      .finally(() => {
        this.maintenance.delete(workspace.guildId);
      });
    this.maintenance.set(workspace.guildId, pending);
  }

  async adminForceCompact(workspace: GuildWorkspace): Promise<HistoryEntry | undefined> {
    return this.compact(workspace, {
      ...this.config,
      memory: {
        ...this.config.memory,
        compaction: {
          ...this.config.memory.compaction,
          maxEventsBeforeCompaction: 1,
          minEventsPerSummary: 1,
        },
      },
    });
  }

  private async compact(
    workspace: GuildWorkspace,
    config: AppConfig = this.config,
  ): Promise<HistoryEntry | undefined> {
    if (this.runner.isAvailable?.() === false) return undefined;
    return new MemoryCompactor(workspace.workspaceRoot, config, async (events) => {
      const result = await this.runner.run({
        sessionId: `compact:${workspace.guildId}`,
        messages: buildCompactionSummaryContext(
          events,
          this.config.runtime.timezone,
          this.botIdentity.userId,
        ),
        allowEmptyText: false,
        traceLabel: "compaction",
      });
      return result.text;
    }).compactIfNeeded();
  }

  async adminForceDream(workspace: GuildWorkspace): Promise<boolean> {
    const result = await new DreamRunner(
      workspace.workspaceRoot,
      this.agentsPath,
      workspace.guildId,
      this.config,
      this.runner,
    ).run("admin");
    return result !== undefined;
  }
}

function snapshotActive(active: ActiveResponse): ActiveResponseSnapshot {
  return {
    id: active.id,
    startedAt: active.startedAt,
    requesterIds: [...active.requesterIds],
    targetMessageIds: [...active.targetMessageIds],
    updatesUsed: active.updatesUsed,
    textPreview: active.textPreview,
    requestMessages: active.requestMessages.map((message) => ({ ...message })),
  };
}
function mergeInputs(first: ReceivedMessage[], second: ReceivedMessage[]): ReceivedMessage[] {
  const unique = new Map([...first, ...second].map((input) => [input.sequence, input]));
  return [...unique.values()].sort((a, b) => a.sequence - b.sequence);
}
function shouldIdleDisengage(config: AppConfig, state: ConversationRuntimeState): boolean {
  return (
    state.unrelatedHumanMessagesSinceLastBot >=
      config.conversation.engaged.disengageAfterUnrelatedHumanMessages ||
    (state.lastHumanMessageAt !== undefined &&
      Date.now() - Date.parse(state.lastHumanMessageAt) >= config.conversation.engaged.disengageAfterIdleMs)
  );
}
