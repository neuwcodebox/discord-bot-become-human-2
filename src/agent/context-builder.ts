import { readFile } from "node:fs/promises";
import { buildTranscript, materializeMessages } from "../conversation/transcript-builder.js";
import type {
  AgentContextMessage,
  AppConfig,
  ConversationRuntimeState,
  EngagementDecision,
  HistoryEntry,
  MemoryInboxEntry,
  NormalizedDiscordEvent,
  NormalizedDiscordMessage,
  StayDecision,
} from "../types.js";
import { loadMemory, loadWorkspaceDocuments } from "./memory-loader.js";
import { SkillLoader } from "./skill-loader.js";
import { loadRelevantUserProfiles } from "./user-profile-loader.js";

export async function buildEngagementDecisionContext(input: {
  agentsPath: string;
  workspaceRoot: string;
  state: ConversationRuntimeState;
  events: NormalizedDiscordEvent[];
  currentMessage: NormalizedDiscordMessage;
}): Promise<AgentContextMessage[]> {
  const [agents, docs] = await Promise.all([
    readFile(input.agentsPath, "utf8"),
    loadWorkspaceDocuments(input.workspaceRoot),
  ]);
  const transcript = buildTranscript(input.events, {
    guildId: input.currentMessage.guildId,
    channelId: input.currentMessage.channelId,
    targetMessageIds: [input.currentMessage.id],
  });
  return [
    {
      role: "system",
      content: `Decide whether the bot should join this Discord conversation. Output JSON only matching this TypeScript shape:\n${engagementShape}`,
    },
    {
      role: "developer",
      content: markdownSections({
        "Runtime Instructions": agents,
        "SOUL.md": docs.soul,
        "GROUP.md": docs.group,
        "Conversation State": JSON.stringify(stripRuntimeOnlyState(input.state), null, 2),
      }),
    },
    {
      role: "user",
      content: markdownSections({
        "Observed Discord Transcript": transcript,
        "Current Message": JSON.stringify(input.currentMessage, null, 2),
      }),
    },
  ];
}

export async function buildStayDecisionContext(input: {
  agentsPath: string;
  workspaceRoot: string;
  state: ConversationRuntimeState;
  events: NormalizedDiscordEvent[];
  currentMessage: NormalizedDiscordMessage;
}): Promise<AgentContextMessage[]> {
  const [agents, docs] = await Promise.all([
    readFile(input.agentsPath, "utf8"),
    loadWorkspaceDocuments(input.workspaceRoot),
  ]);
  const transcript = buildTranscript(input.events, {
    guildId: input.currentMessage.guildId,
    channelId: input.currentMessage.channelId,
    targetMessageIds: [input.currentMessage.id],
  });
  return [
    {
      role: "system",
      content: `Decide whether to stay engaged and what action to take. Output JSON only matching this TypeScript shape:\n${stayShape}`,
    },
    {
      role: "developer",
      content: markdownSections({
        "Runtime Instructions": agents,
        "SOUL.md": docs.soul,
        "GROUP.md": docs.group,
        "Engagement State": JSON.stringify(stripRuntimeOnlyState(input.state), null, 2),
      }),
    },
    {
      role: "user",
      content: markdownSections({
        "Observed Discord Transcript": transcript,
        "Current Message": JSON.stringify(input.currentMessage, null, 2),
      }),
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
  skillNames?: string[];
}): Promise<AgentContextMessage[]> {
  const messages = materializeMessages(input.events);
  const latest = messages.at(-1);
  const [agents, docs, memory, skills, profiles] = await Promise.all([
    readFile(input.agentsPath, "utf8"),
    loadWorkspaceDocuments(input.workspaceRoot),
    loadMemory(input.workspaceRoot),
    new SkillLoader(input.workspaceRoot).load(input.skillNames ?? inferSkills(input.task)),
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
  });
  return [
    {
      role: "system",
      content:
        "Generate the actual Discord reply using ReAct-style tools when useful. Return only the message text that should be sent to Discord.",
    },
    {
      role: "developer",
      content: markdownSections({
        "Runtime Instructions": agents,
        "SOUL.md": docs.soul,
        "GROUP.md": docs.group,
        "TOOLS.md": docs.tools,
        "Activated Skills": skills.map((skill) => skill.body).join("\n\n"),
        "Response Task": JSON.stringify(input.task, null, 2),
      }),
    },
    {
      role: "user",
      content: markdownSections({
        "Guild Memory": memory.guildMemory,
        "Relevant User Profiles": profiles
          .map((profile) => `## ${profile.userId}\n${profile.profile}`)
          .join("\n\n"),
        "Observed Discord Transcript": transcript,
      }),
    },
  ];
}

export async function buildReactionContext(input: {
  agentsPath: string;
  workspaceRoot: string;
  events: NormalizedDiscordEvent[];
  targetMessageIds: string[];
  task: StayDecision;
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
  });
  return [
    {
      role: "system",
      content:
        "Add one natural Discord emoji reaction using the discord_react tool. Do not write a Discord message. Use exactly one tool call and then stop.",
    },
    {
      role: "developer",
      content: markdownSections({
        "Runtime Instructions": agents,
        "SOUL.md": docs.soul,
        "GROUP.md": docs.group,
        "Reaction Task": JSON.stringify(input.task, null, 2),
      }),
    },
    {
      role: "user",
      content: markdownSections({
        "Observed Discord Transcript": transcript,
        "Allowed Action":
          "Choose a target from targetMessageIds and call discord_react with one fitting emoji. Prefer subtle common reactions such as 👍, ✅, 👀, 😄, ❤️, 🙏, or 😮 when appropriate. Do not send text.",
      }),
    },
  ];
}

export async function buildDreamContext(input: {
  agentsPath: string;
  workspaceRoot: string;
  history: HistoryEntry[];
  inbox: MemoryInboxEntry[];
  memory: string;
  config: AppConfig;
  reason: string;
}): Promise<AgentContextMessage[]> {
  const [agents, skills] = await Promise.all([
    readFile(input.agentsPath, "utf8"),
    new SkillLoader(input.workspaceRoot).load(["memory", "workspace-files"]),
  ]);
  return [
    {
      role: "system",
      content:
        "You are running Dream memory maintenance. Edit durable memory conservatively using workspace file tools. Do not over-infer.",
    },
    {
      role: "developer",
      content: markdownSections({
        "Runtime Instructions": agents,
        "Activated Skills": skills.map((skill) => skill.body).join("\n\n"),
        "Dream Scope": JSON.stringify(
          {
            reason: input.reason,
            maxIterations: input.config.memory.dream.maxIterations,
            allowEditSoul: input.config.memory.dream.allowEditSoul,
            allowEditGroup: input.config.memory.dream.allowEditGroup,
            allowEditUserProfiles: input.config.memory.dream.allowEditUserProfiles,
          },
          null,
          2,
        ),
      }),
    },
    {
      role: "user",
      content: markdownSections({
        "New History Entries": input.history.map((entry) => JSON.stringify(entry)).join("\n"),
        "Unprocessed Memory Inbox": input.inbox.map((entry) => JSON.stringify(entry)).join("\n"),
        "Current MEMORY.md": input.memory,
      }),
    },
  ];
}

function inferSkills(task: EngagementDecision | StayDecision): string[] {
  const text = JSON.stringify(task).toLowerCase();
  const names = new Set<string>(["memory", "workspace-files", "discord-actions"]);
  if (text.includes("weather")) names.add("weather");
  if (text.includes("summar")) names.add("summarize");
  return [...names];
}

function markdownSections(sections: Record<string, string>): string {
  return Object.entries(sections)
    .map(([title, body]) => `# ${title}\n\n${body.trim()}`)
    .join("\n\n");
}

function stripRuntimeOnlyState(
  state: ConversationRuntimeState,
): Omit<ConversationRuntimeState, "cooldownUntil" | "pendingFollowUp" | "pendingTimer"> {
  const {
    cooldownUntil: _cooldownUntil,
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
