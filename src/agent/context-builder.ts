import { readFile } from "node:fs/promises";
import { truncateText } from "../context/limits.js";
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
import { loadMemory, loadRecentArchiveSummaries, loadWorkspaceDocuments } from "./memory-loader.js";
import { SkillLoader } from "./skill-loader.js";
import { loadRelevantUserProfiles } from "./user-profile-loader.js";

export async function buildEngagementDecisionContext(input: {
  agentsPath: string;
  workspaceRoot: string;
  state: ConversationRuntimeState;
  events: NormalizedDiscordEvent[];
  currentMessage: NormalizedDiscordMessage;
  timezone?: string;
}): Promise<AgentContextMessage[]> {
  const [agents, docs] = await Promise.all([
    readFile(input.agentsPath, "utf8"),
    loadWorkspaceDocuments(input.workspaceRoot),
  ]);
  const transcript = buildTranscript(input.events, {
    guildId: input.currentMessage.guildId,
    channelId: input.currentMessage.channelId,
    targetMessageIds: [input.currentMessage.id],
    timezone: input.timezone ?? "UTC",
  });
  return [
    {
      role: "system",
      content: sections(
        `Decide whether the bot should join this Discord conversation. Output JSON only matching this TypeScript shape:\n${engagementShape}`,
        block("instructions", agents),
        block("soul", docs.soul),
        block("group", docs.group),
        block("conversation_state", JSON.stringify(stripRuntimeOnlyState(input.state), null, 2)),
      ),
    },
    {
      role: "user",
      content: sections(transcript, block("current_message", JSON.stringify(input.currentMessage, null, 2))),
    },
  ];
}

export async function buildStayDecisionContext(input: {
  agentsPath: string;
  workspaceRoot: string;
  state: ConversationRuntimeState;
  events: NormalizedDiscordEvent[];
  currentMessage: NormalizedDiscordMessage;
  timezone?: string;
}): Promise<AgentContextMessage[]> {
  const [agents, docs] = await Promise.all([
    readFile(input.agentsPath, "utf8"),
    loadWorkspaceDocuments(input.workspaceRoot),
  ]);
  const transcript = buildTranscript(input.events, {
    guildId: input.currentMessage.guildId,
    channelId: input.currentMessage.channelId,
    targetMessageIds: [input.currentMessage.id],
    timezone: input.timezone ?? "UTC",
  });
  return [
    {
      role: "system",
      content: sections(
        `Decide whether to stay engaged and what action to take. Output JSON only matching this TypeScript shape:\n${stayShape}`,
        block("instructions", agents),
        block("soul", docs.soul),
        block("group", docs.group),
        block("action_semantics", stayActionSemantics),
        block("engagement_state", JSON.stringify(stripRuntimeOnlyState(input.state), null, 2)),
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
  });
  const cappedTranscript = truncateText(transcript, input.config.context.maxTranscriptChars).text;
  return [
    {
      role: "system",
      content: sections(
        "Generate the actual Discord reply using ReAct-style tools when useful. Return only the message text that should be sent to Discord.",
        block("instructions", agents),
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
  });
  return [
    {
      role: "system",
      content: sections(
        "Add one natural Discord emoji reaction using the discord_react tool. Do not write a Discord message. Use exactly one tool call and then stop.",
        block("instructions", agents),
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

export type DreamContextInput = {
  agentsPath: string;
  workspaceRoot: string;
  history: HistoryEntry[];
  inbox: MemoryInboxEntry[];
  memory: string;
  soul?: string;
  group?: string;
  userFiles: Map<string, string>;
  existingSkillNames: string[];
  config: AppConfig;
  reason: string;
};

export async function buildDreamPhase1Context(input: DreamContextInput): Promise<AgentContextMessage[]> {
  const agents = await readFile(input.agentsPath, "utf8");
  const dream = input.config.memory.dream;

  const writableFiles = ["memory/MEMORY.md"];
  if (dream.allowEditUserProfiles) writableFiles.push("users/<discord_user_id>/USER.md");
  if (dream.allowEditSoul) writableFiles.push("SOUL.md");
  if (dream.allowEditGroup) writableFiles.push("GROUP.md");
  writableFiles.push("skills/<kebab-name>/SKILL.md");

  return [
    {
      role: "system",
      content: sections(
        `You are reviewing recent conversation history to decide what memory changes are needed.
Do NOT edit files. Output a structured analysis only.

Output format — one finding per line:
[FILE memory/MEMORY.md] atomic fact to add or update
[FILE users/<discord_user_id>/USER.md] user-specific fact to add
[FILE-REMOVE memory/MEMORY.md] short description of content to remove and why
[SKILL kebab-case-name] one-line description of a reusable workflow
[SKIP] if nothing needs updating

Rules:
- [FILE]: extract atomic, durable facts. "prefers ko-KR" not "discussed language"
- [FILE-REMOVE]: only for content that is objectively stale, superseded, or duplicated elsewhere
- [SKILL]: only when a specific multi-step workflow appeared 2+ times in history with clear steps
- Write one line per finding; multiple findings for the same file are fine
- Do not add: transient errors, one-off jokes, simple acknowledgements, debug logs`,
        block("instructions", agents),
        block("guardrails", memoryGuardrails),
        block(
          "scope",
          JSON.stringify(
            {
              reason: input.reason,
              writableFiles,
            },
            null,
            2,
          ),
        ),
      ),
    },
    {
      role: "user",
      content: sections(
        block("current_date", new Date().toISOString().slice(0, 10)),
        block("history", formatHistoryEntries(input.history)),
        block("inbox", input.inbox.map((entry) => JSON.stringify(entry)).join("\n")),
        block("memory_doc", truncateText(input.memory, input.config.context.maxMemoryChars).text),
        input.soul !== undefined
          ? block("soul_doc", truncateText(input.soul, input.config.context.maxUserProfileChars).text)
          : undefined,
        input.group !== undefined
          ? block("group_doc", truncateText(input.group, input.config.context.maxUserProfileChars).text)
          : undefined,
        buildUserDocsBlock(input.userFiles, input.config.context.maxUserProfileChars),
      ),
    },
  ];
}

export async function buildDreamPhase2Context(
  input: DreamContextInput,
  phase1Analysis: string,
): Promise<AgentContextMessage[]> {
  const [agents, skills] = await Promise.all([
    readFile(input.agentsPath, "utf8"),
    new SkillLoader(input.workspaceRoot).load(["memory", "workspace-files"]),
  ]);

  return [
    {
      role: "system",
      content: sections(
        `You are executing memory file edits based on the analysis.
Apply [FILE], [FILE-REMOVE], and [SKILL] entries using workspace file tools.
Surgical edits only — never rewrite entire files.

Editing rules:
- [FILE] → add the atomic fact to the relevant section of the target file
- [FILE-REMOVE] → find the described content and delete it from the file
- [SKILL] → create skills/<name>/SKILL.md with YAML frontmatter (name, description fields). Skip if name already in existing_skills.
- Files below contain current content — use exact strings for old_text matching
- Batch changes to the same file into one workspace_write call`,
        block("instructions", agents),
        block("skills", skills.map((skill) => skill.body).join("\n\n")),
        block("guardrails", memoryGuardrails),
        block(
          "scope",
          JSON.stringify(
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
        ),
      ),
    },
    {
      role: "user",
      content: sections(
        block("analysis", phase1Analysis),
        block("memory_doc", truncateText(input.memory, input.config.context.maxMemoryChars).text),
        input.soul !== undefined
          ? block("soul_doc", truncateText(input.soul, input.config.context.maxUserProfileChars).text)
          : undefined,
        input.group !== undefined
          ? block("group_doc", truncateText(input.group, input.config.context.maxUserProfileChars).text)
          : undefined,
        buildUserDocsBlock(input.userFiles, input.config.context.maxUserProfileChars),
        input.existingSkillNames.length > 0
          ? block("existing_skills", input.existingSkillNames.join("\n"))
          : undefined,
      ),
    },
  ];
}

function formatHistoryEntries(history: HistoryEntry[]): string {
  return history
    .map((entry) => {
      const participants =
        entry.participants.length > 0 ? ` [participants: ${entry.participants.join(", ")}]` : "";
      return `[${entry.time}]${participants} ${entry.summary}`;
    })
    .join("\n");
}

function buildUserDocsBlock(userFiles: Map<string, string>, maxCharsPerFile: number): string | undefined {
  if (userFiles.size === 0) return undefined;
  const parts = [...userFiles.entries()].map(([filePath, content]) => {
    const trimmed = truncateText(content, maxCharsPerFile).text.trim();
    return `<user_doc path="${filePath}">\n${trimmed}\n</user_doc>`;
  });
  return `<user_docs>\n${parts.join("\n")}\n</user_docs>`;
}

function block(tag: string, content: string): string | undefined {
  const trimmed = content.trim();
  return trimmed ? `<${tag}>\n${trimmed}\n</${tag}>` : undefined;
}

function sections(...blocks: Array<string | undefined>): string {
  return blocks.filter((b): b is string => b !== undefined).join("\n\n");
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

const memoryGuardrails = `Only preserve information that is likely to remain useful later.

Do not add or update durable memory for one-off jokes, temporary tests, simple thanks, acknowledgements, transient debugging logs, or ordinary small talk unless the user explicitly asks to remember it.`;

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
