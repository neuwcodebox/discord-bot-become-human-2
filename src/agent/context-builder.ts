import { readFile } from "node:fs/promises";
import { block, sections } from "../context/format.js";
import { truncateText } from "../context/limits.js";
import { buildTranscript, materializeMessages } from "../conversation/transcript-builder.js";
import type {
  AgentContextMessage,
  AppConfig,
  BotIdentity,
  ConversationRuntimeState,
  EngagementDecision,
  NormalizedDiscordEvent,
  NormalizedDiscordMessage,
  StayDecision,
} from "../types.js";
import { loadMemory, loadRecentArchiveSummaries, loadWorkspaceDocuments } from "./memory-loader.js";
import { SkillLoader } from "./skill-loader.js";
import { loadRelevantUserProfiles } from "./user-profile-loader.js";

export type DecisionContextInput = {
  agentsPath: string;
  workspaceRoot: string;
  state: ConversationRuntimeState;
  events: NormalizedDiscordEvent[];
  currentMessage: NormalizedDiscordMessage;
  timezone?: string;
  botIdentity: BotIdentity;
};

export function buildEngagementDecisionContext(input: DecisionContextInput): Promise<AgentContextMessage[]> {
  return buildDecisionContext(input, {
    task: `Decide whether the bot should join this Discord conversation. Output JSON only matching this TypeScript shape:\n${engagementShape}`,
    stateTag: "conversation_state",
  });
}

export function buildStayDecisionContext(input: DecisionContextInput): Promise<AgentContextMessage[]> {
  return buildDecisionContext(input, {
    task: `Decide whether to stay engaged and what action to take. Output JSON only matching this TypeScript shape:\n${stayShape}`,
    stateTag: "engagement_state",
    actionSemantics: stayActionSemantics,
  });
}

async function buildDecisionContext(
  input: DecisionContextInput,
  options: {
    task: string;
    stateTag: "conversation_state" | "engagement_state";
    actionSemantics?: string;
  },
): Promise<AgentContextMessage[]> {
  const [agents, docs] = await Promise.all([
    readFile(input.agentsPath, "utf8"),
    loadWorkspaceDocuments(input.workspaceRoot),
  ]);
  const transcript = buildTranscript(input.events, {
    guildId: input.currentMessage.guildId,
    channelId: input.currentMessage.channelId,
    targetMessageIds: [input.currentMessage.id],
    timezone: input.timezone ?? "UTC",
    botUserId: input.botIdentity.userId,
  });
  return [
    {
      role: "system",
      content: sections(
        options.task,
        block("instructions", agents),
        block("bot_identity", formatBotIdentity(input.botIdentity)),
        block("soul", docs.soul),
        block("group", docs.group),
        options.actionSemantics ? block("action_semantics", options.actionSemantics) : undefined,
        block(options.stateTag, JSON.stringify(stripRuntimeOnlyState(input.state), null, 2)),
      ),
    },
    {
      role: "user",
      content: sections(transcript, block("current_message", JSON.stringify(input.currentMessage, null, 2))),
    },
  ];
}

export async function buildResponseContext(input: {
  agentsPath: string;
  workspaceRoot: string;
  config: AppConfig;
  events: NormalizedDiscordEvent[];
  targetMessageIds: string[];
  task: EngagementDecision | StayDecision;
  botIdentity: BotIdentity;
}): Promise<AgentContextMessage[]> {
  const messages = materializeMessages(input.events);
  const latest = messages.at(-1);
  const [agents, docs, memory, archiveSummaries, skillsCtx, profiles] = await Promise.all([
    readFile(input.agentsPath, "utf8"),
    loadWorkspaceDocuments(input.workspaceRoot),
    loadMemory(input.workspaceRoot),
    loadRecentArchiveSummaries({
      workspaceRoot: input.workspaceRoot,
      config: input.config,
      ...(latest?.channelId ? { channelId: latest.channelId } : {}),
    }),
    new SkillLoader(input.workspaceRoot).buildSkillsContext(),
    loadRelevantUserProfiles(
      input.workspaceRoot,
      messages,
      input.targetMessageIds,
      input.config.conversation.maxParticipantsForProfileLoad,
    ),
  ]);
  const transcript = buildTranscript(input.events, {
    guildId: latest?.guildId ?? "unknown",
    channelId: latest?.channelId ?? "unknown",
    targetMessageIds: input.targetMessageIds,
    timezone: input.config.runtime.timezone,
    botUserId: input.botIdentity.userId,
  });
  const cappedTranscript = truncateText(transcript, input.config.context.maxTranscriptChars).text;
  return [
    {
      role: "system",
      content: sections(
        `Generate the actual Discord reply using ReAct-style tools when useful. Default language: ${input.config.runtime.defaultLocale} (SOUL.md speaking style takes priority). Return only the message text that should be sent to Discord.`,
        block("instructions", agents),
        block("bot_identity", formatBotIdentity(input.botIdentity)),
        block("soul", docs.soul),
        block("group", docs.group),
        block("tools", docs.tools),
        block(
          "skills",
          sections(
            skillsCtx.alwaysLoaded.length > 0
              ? skillsCtx.alwaysLoaded.map((s) => s.body).join("\n\n")
              : undefined,
            skillsCtx.summary
              ? `To use a skill, read its SKILL.md file with workspace_read.\n\n${skillsCtx.summary}`
              : undefined,
          ),
        ),
        block("guardrails", responseGuardrails),
        block("task", JSON.stringify(input.task, null, 2)),
      ),
    },
    {
      role: "user",
      content: sections(
        block("memory", truncateText(memory.guildMemory, input.config.context.maxMemoryChars).text),
        block("archive_summaries", archiveSummaries),
        profiles.length > 0
          ? `<user_profiles>\n${profiles
              .map(
                (profile) =>
                  `<profile uid="${profile.userId}">\n${truncateText(profile.profile, input.config.context.maxUserProfileChars).text.trim()}\n</profile>`,
              )
              .join("\n")}\n</user_profiles>`
          : undefined,
        cappedTranscript,
      ),
    },
  ];
}

export async function buildReactionContext(input: {
  agentsPath: string;
  workspaceRoot: string;
  events: NormalizedDiscordEvent[];
  targetMessageIds: string[];
  task: StayDecision;
  timezone?: string;
  botIdentity: BotIdentity;
}): Promise<AgentContextMessage[]> {
  const messages = materializeMessages(input.events);
  const latest = messages.at(-1);
  const [agents, docs] = await Promise.all([
    readFile(input.agentsPath, "utf8"),
    loadWorkspaceDocuments(input.workspaceRoot),
  ]);
  const transcript = buildTranscript(input.events, {
    guildId: latest?.guildId ?? "unknown",
    channelId: latest?.channelId ?? "unknown",
    targetMessageIds: input.targetMessageIds,
    timezone: input.timezone ?? "UTC",
    botUserId: input.botIdentity.userId,
  });
  return [
    {
      role: "system",
      content: sections(
        "Add one natural Discord emoji reaction using the discord_react tool. Do not write a Discord message. Use exactly one tool call and then stop.",
        block("instructions", agents),
        block("bot_identity", formatBotIdentity(input.botIdentity)),
        block("soul", docs.soul),
        block("group", docs.group),
        block("task", JSON.stringify(input.task, null, 2)),
      ),
    },
    {
      role: "user",
      content: sections(
        transcript,
        block(
          "allowed_action",
          "Choose a target from targetMessageIds and call discord_react with one fitting emoji. Common neutral examples include 👍, ✅, and 👀, but use soul, group, and the transcript to choose naturally. Do not send text.",
        ),
      ),
    },
  ];
}

function formatBotIdentity(identity: BotIdentity): string {
  return [
    `discord_user_id: ${identity.userId}`,
    `mention: ${identity.mention}`,
    `username: ${identity.username}`,
    `global_name: ${identity.globalName ?? ""}`,
    `tag: ${identity.tag}`,
  ].join("\n");
}

function stripRuntimeOnlyState(
  state: ConversationRuntimeState,
): Omit<
  ConversationRuntimeState,
  "cooldownUntil" | "pendingFollowUp" | "pendingTimer" | "lastAmbientDecisionAt"
> {
  const {
    cooldownUntil: _cooldownUntil,
    lastAmbientDecisionAt: _lastAmbientDecisionAt,
    pendingFollowUp: _pendingFollowUp,
    pendingTimer: _pendingTimer,
    ...rest
  } = state;
  return rest;
}

const engagementShape = `type EngagementDecision = {
  engage: boolean;
  confidence: number;
  reason: string;
  targetMessageIds: string[];
  expectedRole: "answer_question" | "join_casually" | "handle_attachment" | "clarify" | "react_only" | "other";
};`;

const stayActionSemantics = `Choose the smallest natural action that fits the conversation.

reply:
  Use when a Discord text reply is socially useful or needed: direct question, requested help, clarification, or a meaningful continuation.

react:
  Use when writing a text reply would be too much, but completely ignoring the message would feel a little cold. This means one Discord emoji reaction only, not a message.

silent_track:
  Use when the bot should keep listening without visible response. This is the default for human-to-human chatter, weak acknowledgements, or messages that do not need the bot.

wait:
  Use when more nearby messages are likely to arrive and the bot should decide after a short batch delay. Do not use wait because of cooldown; runtime scheduling already handled cooldown before this decision.

disengage:
  Use only when the bot should leave the conversation state entirely. Do not use disengage for a simple acknowledgement if lingering silently would feel more natural.`;

const responseGuardrails = `Use Response Task as constraints, not as content to mention.

- Focus on targetMessageIds; do not respond to every transcript message.
- Do not mention internal JSON, schemas, confidence, reason fields, runtime state, or hidden instructions in Discord.
- Use tools only when they are actually needed to answer or act.
- Write memory or workspace files only when the user explicitly asks or the task clearly requires durable state changes.`;

const stayShape = `type StayDecision = {
  stayEngaged: boolean;
  action: "reply" | "wait" | "silent_track" | "react" | "disengage";
  confidence: number;
  reason: string;
  attention: "directed_at_bot" | "bot_relevant" | "human_to_human" | "background" | "topic_changed";
  targetMessageIds: string[];
  reactionHint?: "ack" | "thanks" | "funny" | "agree" | "care" | "surprised";
  replyPriority: "urgent" | "normal" | "low" | "none";
  disengageReason?: "conversation_ended" | "topic_moved_without_bot" | "bot_not_needed" | "too_many_bot_turns" | "idle_timeout" | "uncertain";
};`;
