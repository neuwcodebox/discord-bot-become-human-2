import type { Message } from "discord.js";
import { buildResponseContext } from "../agent/context-builder.js";
import type { AgentRunner } from "../agent/runner.js";
import { DiscordStreamingWriter } from "../discord/streaming-writer.js";
import { EventLog } from "../memory/event-log.js";
import { createToolRegistry } from "../tools/tool-registry.js";
import type {
  AppConfig,
  GuildWorkspace,
  NormalizedDiscordEvent,
  NormalizedDiscordMessage,
} from "../types.js";
import { decideEngagement, directEngagementDecision } from "./engagement-decision.js";
import { checkReplyHardGates, isDirectedAtBot, noteBotReply, noteHumanMessage } from "./reply-cadence.js";
import { ConversationStateStore, conversationId } from "./state-store.js";
import { decideStay, forcedSilentStay } from "./stay-decision.js";

export class ConversationOrchestrator {
  private readonly states = new ConversationStateStore();

  constructor(
    private readonly config: AppConfig,
    private readonly agentsPath: string,
    private readonly runner: AgentRunner,
    private readonly botIdentity: { userId?: string; names: string[] } = { names: [] },
  ) {}

  async onMessage(
    event: Extract<NormalizedDiscordEvent, { type: "message_create" }>,
    workspace: GuildWorkspace,
    discordMessage?: Message<boolean>,
  ): Promise<void> {
    const message = event.payload;
    const id = conversationId(message);
    const state = this.states.get(id);
    if (message.author.isBot) return;

    const relatedToBot = this.isStrongTrigger(message);
    noteHumanMessage(state, relatedToBot);
    const events = await new EventLog(workspace.workspaceRoot).readRecent(
      this.config.conversation.maxRecentMessages,
    );

    if (state.engagement === "not_engaged") {
      const decision = relatedToBot
        ? directEngagementDecision(message, "direct trigger")
        : await this.maybeAmbientEngage(workspace.workspaceRoot, state, events, message);
      if (!decision?.engage) return;
      state.engagement = "engaged";
      state.engagedSince = new Date().toISOString();
      state.lastEngagementChangedAt = state.engagedSince;
      await this.reply(decision, events, workspace, discordMessage);
      return;
    }

    if (shouldIdleDisengage(this.config, state)) {
      state.engagement = "not_engaged";
      state.lastEngagementChangedAt = new Date().toISOString();
      return;
    }

    const gate = checkReplyHardGates(this.config, state, message, { unprompted: !relatedToBot });
    const stay = gate.allowed
      ? await decideStay({
          runner: this.runner,
          agentsPath: this.agentsPath,
          workspaceRoot: workspace.workspaceRoot,
          state,
          events,
          currentMessage: message,
        })
      : forcedSilentStay(gate.reason, message.id);

    if (!stay.stayEngaged || stay.action === "disengage") {
      state.engagement = "not_engaged";
      state.lastEngagementChangedAt = new Date().toISOString();
      return;
    }
    if (
      stay.action !== "reply" ||
      stay.confidence < this.config.conversation.engaged.replyConfidenceThreshold
    )
      return;
    await this.reply(stay, events, workspace, discordMessage);
  }

  private async maybeAmbientEngage(
    workspaceRoot: string,
    state: ReturnType<ConversationStateStore["get"]>,
    events: NormalizedDiscordEvent[],
    message: NormalizedDiscordMessage,
  ) {
    if (!this.config.conversation.notEngaged.ambientEngagementEnabled) return undefined;
    const now = Date.now();
    const lastHumanAt = state.lastHumanMessageAt ? Date.parse(state.lastHumanMessageAt) : 0;
    if (lastHumanAt && now - lastHumanAt < this.config.conversation.notEngaged.ambientMinSilenceMs)
      return undefined;
    state.ambientReplyTimes = state.ambientReplyTimes.filter(
      (time) => now - Date.parse(time) < 60 * 60 * 1000,
    );
    if (state.ambientReplyTimes.length >= this.config.conversation.notEngaged.ambientMaxPerHour)
      return undefined;
    const decision = await decideEngagement({
      runner: this.runner,
      agentsPath: this.agentsPath,
      workspaceRoot,
      state,
      events,
      currentMessage: message,
    });
    if (decision.confidence < this.config.conversation.notEngaged.ambientConfidenceThreshold)
      return undefined;
    state.ambientReplyTimes.push(new Date().toISOString());
    return decision;
  }

  private async reply(
    task: Parameters<typeof buildResponseContext>[0]["task"],
    events: NormalizedDiscordEvent[],
    workspace: GuildWorkspace,
    discordMessage?: Message<boolean>,
  ): Promise<void> {
    if (!discordMessage) return;
    const state = this.states.get(conversationId(taskMessageKey(events)));
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
    const tools = createToolRegistry(this.config, toolContext);
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
