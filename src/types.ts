import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, Model, TSchema } from "@earendil-works/pi-ai";

export type { AppConfig } from "./config.js";

export type RuntimeAgentTool = AgentTool<TSchema, unknown>;
export type RuntimeModel = Model<Api>;

export type BotIdentity = {
  userId: string;
  username: string;
  globalName: string | null;
  tag: string;
  mention: string;
  names: string[];
};

export type MaybePromise<T> = T | Promise<T>;

export type TupleRangeMs = readonly [number, number];

export type RuntimePaths = {
  projectRoot: string;
  resourcesAgentsPath: string;
  templatesWorkspaceRoot: string;
  runtimeRoot: string;
  configPath: string;
  codexAuthPath?: string;
  guildsRoot: string;
};

export type GuildWorkspace = {
  guildId: string;
  guildRoot: string;
  workspaceRoot: string;
};

export type AttachmentKind = "image" | "video" | "audio" | "file" | "sticker" | "emoji" | "unknown";

export type NormalizedDiscordMessage = {
  id: string;
  guildId: string;
  channelId: string;
  threadId?: string;
  author: {
    id: string;
    username: string;
    displayName: string;
    isBot: boolean;
  };
  content: string;
  cleanContent: string;
  createdAt: string;
  editedAt?: string;
  replyTo?: {
    messageId: string;
    authorId?: string;
    authorDisplayName?: string;
    contentPreview?: string;
    attachments?: Array<{
      id: string;
      url: string;
      filename: string;
      mimeType?: string;
      size?: number;
      kind: AttachmentKind;
    }>;
    embeds?: Array<{
      title?: string;
      description?: string;
      url?: string;
      imageUrl?: string;
    }>;
  };
  mentions: Array<{
    id: string;
    displayName: string;
  }>;
  attachments: Array<{
    id: string;
    url: string;
    filename: string;
    mimeType?: string;
    size?: number;
    kind: AttachmentKind;
  }>;
  embeds: Array<{
    title?: string;
    description?: string;
    url?: string;
    imageUrl?: string;
  }>;
  reactions: Array<{
    emoji: string;
    count: number;
    me: boolean;
  }>;
  links: string[];
  deletedAt?: string;
};

export type NormalizedDiscordEvent =
  | {
      cursor?: number;
      type: "message_create";
      time: string;
      guildId: string;
      channelId: string;
      threadId?: string;
      messageId: string;
      authorId?: string;
      payload: NormalizedDiscordMessage;
    }
  | {
      cursor?: number;
      type: "message_update";
      time: string;
      guildId: string;
      channelId: string;
      threadId?: string;
      messageId: string;
      authorId?: string;
      payload: NormalizedDiscordMessage;
    }
  | {
      cursor?: number;
      type: "message_delete";
      time: string;
      guildId: string;
      channelId: string;
      threadId?: string;
      messageId: string;
      authorId?: string;
      payload: { deletedAt: string };
    }
  | {
      cursor?: number;
      type: "reaction_add" | "reaction_remove";
      time: string;
      guildId: string;
      channelId: string;
      threadId?: string;
      messageId: string;
      authorId?: string;
      payload: {
        userId: string;
        emoji: string;
      };
    };

export type EngagementState = "not_engaged" | "engaged";

export type ConversationRuntimeState = {
  engagement: EngagementState;
  lastBotMessageAt?: string;
  lastHumanMessageAt?: string;
  lastEngagementChangedAt?: string;
  lastAmbientDecisionAt?: string;
  engagedSince?: string;
  recentBotMessageIds: string[];
  consecutiveBotReplies: number;
  humanMessagesSinceLastBot: number;
  unrelatedHumanMessagesSinceLastBot: number;
  cooldownUntil?: string;
  pendingTimer?: NodeJS.Timeout;
  pendingFollowUp?: PendingFollowUpBatch;
  ambientReplyTimes: string[];
  processingChain?: Promise<void>;
};

export type PendingFollowUpBatch = {
  since: string;
  lastMessageAt: string;
  messageIds: string[];
  relatedToBot: boolean;
  waitCount: number;
};

export type EngagementDecision = {
  engage: boolean;
  confidence: number;
  reason: string;
  targetMessageIds: string[];
  expectedRole:
    | "answer_question"
    | "join_casually"
    | "handle_attachment"
    | "clarify"
    | "react_only"
    | "other";
};

export type StayDecision = {
  stayEngaged: boolean;
  action: "reply" | "wait" | "silent_track" | "react" | "disengage";
  confidence: number;
  reason: string;
  attention: "directed_at_bot" | "bot_relevant" | "human_to_human" | "background" | "topic_changed";
  targetMessageIds: string[];
  reactionHint?: "ack" | "thanks" | "funny" | "agree" | "care" | "surprised" | undefined;
  replyPriority: "urgent" | "normal" | "low" | "none";
  disengageReason?:
    | "conversation_ended"
    | "topic_moved_without_bot"
    | "bot_not_needed"
    | "too_many_bot_turns"
    | "idle_timeout"
    | "uncertain"
    | undefined;
};

export type ToolContext = {
  guildId: string;
  workspaceRoot: string;
  channelId?: string;
  threadId?: string;
  actorUserId?: string;
};

export type MemoryInboxEntry = {
  time: string;
  source: "conversation" | "manual" | "dream" | string;
  target: string;
  confidence: number;
  note: string;
  evidenceMessageIds: string[];
  processedAt?: string | undefined;
};

export type HistoryEntry = {
  cursor: number;
  time: string;
  fromEventCursor: number;
  toEventCursor: number;
  guildId?: string;
  channelIds?: string[];
  threadIds?: string[];
  participants: string[];
  summary: string;
  memoryTargets: string[];
};

export type AgentRole = "system" | "user" | "assistant" | "tool";

export type AgentContextMessage = {
  role: AgentRole;
  content: string;
};

export type AgentRunRequest = {
  sessionId: string;
  messages: AgentContextMessage[];
  tools?: RuntimeAgentTool[];
  signal?: AbortSignal;
  onTextDelta?: (text: string) => MaybePromise<void>;
  allowEmptyText?: boolean;
  traceLabel?: string;
};

export type AgentRunResult = {
  text: string;
  messages?: AgentMessage[];
};
