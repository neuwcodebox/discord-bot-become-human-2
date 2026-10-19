import type { Message, TextBasedChannel } from "discord.js";
import { AgentUnavailableError } from "../agent/availability.js";
import { buildReactionContext, buildResponseContext } from "../agent/context-builder.js";
import type { AgentRunner } from "../agent/runner.js";
import type { AttachmentCache } from "../discord/attachment-cache.js";
import { sendDiscordMessage } from "../discord/sender.js";
import { DiscordStreamingWriter } from "../discord/streaming-writer.js";
import { childLogger } from "../logger.js";
import { createDiscordActionRuntimeFromMessage } from "../tools/discord-actions.js";
import { createToolRegistry } from "../tools/tool-registry.js";
import type {
  AgentContextMessage,
  AgentRunRequest,
  AgentRunResult,
  AppConfig,
  BotIdentity,
  EngagementDecision,
  GuildWorkspace,
  NormalizedDiscordEvent,
  NormalizedDiscordMessage,
  RuntimeAgentTool,
  StayDecision,
  ToolContext,
} from "../types.js";

const log = childLogger("conversation");

export type ResponseOptions = Pick<AgentRunRequest, "signal" | "onControlReady"> & {
  onProgress?: (text: string) => void;
};

export class ConversationResponder {
  constructor(
    private readonly config: AppConfig,
    private readonly agentsPath: string,
    private readonly runner: AgentRunner,
    private readonly botIdentity: BotIdentity,
    private readonly attachmentCache: AttachmentCache,
  ) {}

  async reply(
    task: EngagementDecision | StayDecision,
    events: NormalizedDiscordEvent[],
    workspace: GuildWorkspace,
    discordMessage?: Message<boolean>,
    options: ResponseOptions = {},
  ): Promise<string | undefined> {
    if (!discordMessage) {
      log.warn({ guildId: workspace.guildId }, "reply skipped because discord message is unavailable");
      return;
    }
    const startedAt = Date.now();
    log.info(
      {
        guildId: workspace.guildId,
        channelId: discordMessage.channelId,
        targetMessageIds: task.targetMessageIds,
        action: "reply",
      },
      "agent reply started",
    );
    const stopTyping = startTypingKeepAlive(discordMessage.channel);
    options.signal?.addEventListener("abort", stopTyping, { once: true });
    let writer: DiscordStreamingWriter | undefined;
    try {
      options.signal?.throwIfAborted();
      const context = await buildResponseContext({
        agentsPath: this.agentsPath,
        workspaceRoot: workspace.workspaceRoot,
        config: this.config,
        events,
        targetMessageIds: task.targetMessageIds,
        task,
        botIdentity: this.botIdentity,
      });
      const streaming = this.config.streaming.enabled && this.config.discord.enableMessageEditStreaming;
      const sendState = { firstReplySent: false };
      options.signal?.throwIfAborted();
      writer = streaming
        ? new DiscordStreamingWriter(
            discordMessage.channel,
            this.config,
            discordMessage,
            sendState,
            stopTyping,
            options.signal,
          )
        : undefined;
      const toolContext = createToolContext(workspace, discordMessage);
      const tools = createToolRegistry(this.config, toolContext, {
        attachmentCache: this.attachmentCache,
        discordActions: createDiscordActionRuntimeFromMessage(
          discordMessage,
          toolContext,
          sendState,
          {
            softLimitChars: this.config.streaming.softLimitChars,
            hardLimitChars: this.config.streaming.hardLimitChars,
            maxToolResultChars: this.config.context.maxToolResultChars,
          },
          async () => {
            options.signal?.throwIfAborted();
            await writer?.forceFlush();
          },
          options.signal,
        ),
      });
      let progress = "";
      const streamOptions: Pick<AgentRunRequest, "onTextDelta" | "onAssistantMessageStart"> = {
        onAssistantMessageStart: async () => {
          options.signal?.throwIfAborted();
          progress = "";
          options.onProgress?.(progress);
          await writer?.startMessage();
        },
        onTextDelta: async (delta) => {
          options.signal?.throwIfAborted();
          progress += delta;
          options.onProgress?.(progress);
          await writer?.append(delta);
        },
      };
      const corrections: AgentContextMessage[] = [];
      const onControlReady: NonNullable<AgentRunRequest["onControlReady"]> = (control) => {
        options.onControlReady?.({
          steer(contents) {
            if (!control.steer(contents)) return false;
            corrections.push({ role: "user", content: contents });
            return true;
          },
        });
      };
      const runOptions = {
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.onControlReady ? { onControlReady } : {}),
      };
      const result = await this.runner.run({
        sessionId: `discord:${workspace.guildId}:${discordMessage.channelId}`,
        messages: context,
        tools,
        traceLabel: "response",
        ...runOptions,
        ...streamOptions,
      });
      const finalResult = await this.retryEmptyReply({
        result,
        context: [...context, ...corrections],
        workspace,
        discordMessage,
        streaming,
        ...runOptions,
        ...streamOptions,
      });
      const text = replyTextOrFallback(finalResult.text);
      options.signal?.throwIfAborted();
      const sent = writer
        ? await writer.finish(text)
        : await sendDiscordMessage(
            discordMessage.channel,
            text,
            sendState.firstReplySent ? {} : { replyTo: discordMessage },
          );
      log.info(
        {
          guildId: workspace.guildId,
          channelId: discordMessage.channelId,
          messageId: sent?.id,
          streaming,
          durationMs: Date.now() - startedAt,
          outputLength: finalResult.text.length,
        },
        "agent reply completed",
      );
      return sent?.id;
    } catch (error) {
      if (!options.signal?.aborted && !(error instanceof AgentUnavailableError)) throw error;
      log.info({ guildId: workspace.guildId, channelId: discordMessage.channelId }, "agent reply cancelled");
      return writer?.lastMessageId;
    } finally {
      options.signal?.removeEventListener("abort", stopTyping);
      stopTyping();
    }
  }

  async react(
    task: StayDecision,
    events: NormalizedDiscordEvent[],
    workspace: GuildWorkspace,
    discordMessage: Message<boolean>,
    currentMessage: NormalizedDiscordMessage,
  ): Promise<void> {
    const startedAt = Date.now();
    const targetMessageIds = task.targetMessageIds.length > 0 ? task.targetMessageIds : [currentMessage.id];
    const reactionTask: StayDecision = { ...task, stayEngaged: true, targetMessageIds };
    const toolContext = createToolContext(workspace, discordMessage);
    let reacted = false;
    const tools = reactionOnlyTools(
      createToolRegistry(this.config, toolContext, {
        discordActions: createDiscordActionRuntimeFromMessage(discordMessage, toolContext),
      }),
      () => {
        reacted = true;
      },
    );
    if (tools.length === 0) {
      log.warn(
        {
          guildId: workspace.guildId,
          channelId: discordMessage.channelId,
          messageId: currentMessage.id,
          targetMessageIds,
        },
        "agent reaction skipped because discord_react tool is unavailable",
      );
      return;
    }
    log.info(
      {
        guildId: workspace.guildId,
        channelId: discordMessage.channelId,
        targetMessageIds,
        reactionHint: reactionTask.reactionHint,
      },
      "agent reaction started",
    );
    try {
      const result = await this.runner.run({
        sessionId: `react:${workspace.guildId}:${discordMessage.channelId}`,
        messages: await buildReactionContext({
          agentsPath: this.agentsPath,
          workspaceRoot: workspace.workspaceRoot,
          events,
          targetMessageIds,
          task: reactionTask,
          timezone: this.config.runtime.timezone,
          botIdentity: this.botIdentity,
        }),
        tools,
        allowEmptyText: true,
        traceLabel: "reaction",
      });
      log.info(
        {
          guildId: workspace.guildId,
          channelId: discordMessage.channelId,
          targetMessageIds,
          durationMs: Date.now() - startedAt,
          outputLength: result.text.length,
          reacted,
        },
        "agent reaction completed",
      );
      if (!reacted) {
        log.warn(
          {
            guildId: workspace.guildId,
            channelId: discordMessage.channelId,
            targetMessageIds,
            outputLength: result.text.length,
          },
          "agent reaction completed without discord_react call",
        );
      }
    } catch (error) {
      log.warn(
        {
          err: error,
          guildId: workspace.guildId,
          channelId: discordMessage.channelId,
          targetMessageIds,
          durationMs: Date.now() - startedAt,
        },
        "agent reaction failed",
      );
    }
  }

  private async retryEmptyReply(input: {
    result: AgentRunResult;
    context: AgentContextMessage[];
    workspace: GuildWorkspace;
    discordMessage: Message<boolean>;
    streaming: boolean;
    onTextDelta?: AgentRunRequest["onTextDelta"];
    onAssistantMessageStart?: AgentRunRequest["onAssistantMessageStart"];
    signal?: AbortSignal;
    onControlReady?: AgentRunRequest["onControlReady"];
  }): Promise<AgentRunResult> {
    input.signal?.throwIfAborted();
    if (input.result.text.trim().length > 0) return input.result;
    log.warn(
      {
        guildId: input.workspace.guildId,
        channelId: input.discordMessage.channelId,
        messageId: input.discordMessage.id,
        streaming: input.streaming,
      },
      "agent reply was empty; retrying without tools",
    );
    return this.runner.run({
      sessionId: `discord-retry:${input.workspace.guildId}:${input.discordMessage.channelId}`,
      traceLabel: "response_retry",
      messages: [
        ...input.context,
        {
          role: "system",
          content:
            "The previous response generation returned empty text. Produce the Discord reply now as plain message text only. Do not call tools.",
        },
      ],
      ...(input.onTextDelta ? { onTextDelta: input.onTextDelta } : {}),
      ...(input.onAssistantMessageStart ? { onAssistantMessageStart: input.onAssistantMessageStart } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.onControlReady ? { onControlReady: input.onControlReady } : {}),
    });
  }
}

function createToolContext(workspace: GuildWorkspace, message: Message<boolean>): ToolContext {
  return {
    guildId: workspace.guildId,
    workspaceRoot: workspace.workspaceRoot,
    channelId: message.channelId,
    ...(message.channel.isThread() ? { threadId: message.channel.id } : {}),
    actorUserId: message.author.id,
  };
}

function startTypingKeepAlive(channel: TextBasedChannel): () => void {
  if (!channel.isSendable()) return () => {};
  void channel.sendTyping().catch(() => {});
  const timer = setInterval(() => {
    void channel.sendTyping().catch(() => {});
  }, 8000);
  return () => clearInterval(timer);
}

function replyTextOrFallback(text: string): string {
  return text.trim().length > 0 ? text : "방금 답변을 제대로 만들지 못했어요.";
}

function reactionOnlyTools(tools: RuntimeAgentTool[], onReact: () => void): RuntimeAgentTool[] {
  const reactTool = tools.find((tool) => tool.name === "discord_react");
  if (!reactTool) return [];
  return [
    {
      ...reactTool,
      execute: async (...args: Parameters<RuntimeAgentTool["execute"]>) => {
        const result = await reactTool.execute(...args);
        onReact();
        return { ...result, terminate: true };
      },
    },
  ];
}
