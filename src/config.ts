import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

const tupleMsSchema = z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]).readonly();
const defaultFollowUpBatchConfig = {
  quietDebounceMs: [3000, 5000] as const,
  directTriggerDebounceMs: [1000, 2000] as const,
  maxWaitMs: 15000,
  maxMessages: 4,
};
const followUpBatchSchema = z
  .object({
    quietDebounceMs: tupleMsSchema,
    directTriggerDebounceMs: tupleMsSchema,
    maxWaitMs: z.number().int().positive(),
    maxMessages: z.number().int().positive(),
  })
  .default(defaultFollowUpBatchConfig);

const codexLlmSchema = z.object({
  provider: z.literal("openai-codex"),
  model: z.string().min(1),
  reasoning: z.enum(["low", "medium", "high", "xhigh"]),
  codex: z.object({
    authPath: z.string().min(1),
    transport: z.enum(["auto", "responses", "websocket"]),
  }),
});

const openaiCompatLlmSchema = z.object({
  provider: z.literal("openai-compatible"),
  model: z.string().min(1),
  baseURL: z.string().min(1),
  apiKeyEnv: z.string().min(1),
  contextWindow: z.number().int().positive(),
  reasoning: z.enum(["low", "medium", "high", "xhigh"]).default("medium"),
});

export type CodexLlmConfig = z.infer<typeof codexLlmSchema>;
export type OpenAICompatLlmConfig = z.infer<typeof openaiCompatLlmSchema>;

const configSchema = z.object({
  discord: z.object({
    tokenEnv: z.string().min(1),
    allowedGuildIds: z.array(z.string()),
    allowedChannelIds: z.array(z.string()),
    enableMentions: z.boolean(),
    enableReplies: z.boolean(),
    enableReactions: z.boolean(),
    enableMessageEditStreaming: z.boolean(),
  }),
  llm: z.discriminatedUnion("provider", [codexLlmSchema, openaiCompatLlmSchema]),
  runtime: z.object({
    rootDir: z.string().min(1),
    defaultLocale: z.string().min(1),
    timezone: z.string().min(1),
  }),
  conversation: z.object({
    maxRecentMessages: z.number().int().positive(),
    maxParticipantsForProfileLoad: z.number().int().positive(),
    notEngaged: z.object({
      engageDebounceMs: tupleMsSchema,
      directTriggerConfidence: z.number().min(0).max(1),
      ambientEngagementEnabled: z.boolean(),
      ambientMinSilenceMs: z.number().int().nonnegative(),
      ambientConfidenceThreshold: z.number().min(0).max(1),
      ambientMaxPerHour: z.number().int().nonnegative(),
    }),
    engaged: z.object({
      followUpBatch: followUpBatchSchema,
      minSecondsBetweenBotReplies: z.number().int().nonnegative(),
      minSecondsBetweenUnpromptedReplies: z.number().int().nonnegative(),
      maxConsecutiveBotReplies: z.number().int().nonnegative(),
      replyConfidenceThreshold: z.number().min(0).max(1),
      silentStayConfidenceThreshold: z.number().min(0).max(1),
      disengageAfterUnrelatedHumanMessages: z.number().int().nonnegative(),
      disengageAfterIdleMs: z.number().int().nonnegative(),
    }),
    cooldownMs: tupleMsSchema,
  }),
  streaming: z.object({
    enabled: z.boolean(),
    initialPlaceholder: z.string(),
    editIntervalMs: z.number().int().positive(),
    softLimitChars: z.number().int().positive(),
    hardLimitChars: z.number().int().positive(),
  }),
  context: z
    .object({
      outputReserveTokens: z.number().int().positive(),
      safetyBufferTokens: z.number().int().nonnegative(),
      maxContextMessageChars: z.number().int().positive(),
      maxTranscriptChars: z.number().int().positive(),
      maxArchiveSummariesInContext: z.number().int().nonnegative(),
      maxArchiveSummaryChars: z.number().int().positive(),
      maxMemoryChars: z.number().int().positive(),
      maxUserProfileChars: z.number().int().positive(),
      maxToolResultChars: z.number().int().positive(),
      maxFileReadBytes: z.number().int().positive(),
      maxSearchResultChars: z.number().int().positive(),
    })
    .default({
      outputReserveTokens: 16_000,
      safetyBufferTokens: 2_048,
      maxContextMessageChars: 96_000,
      maxTranscriptChars: 64_000,
      maxArchiveSummariesInContext: 8,
      maxArchiveSummaryChars: 12_000,
      maxMemoryChars: 32_000,
      maxUserProfileChars: 16_000,
      maxToolResultChars: 16_000,
      maxFileReadBytes: 131_072,
      maxSearchResultChars: 2_000,
    }),
  memory: z.object({
    compaction: z.object({
      enabled: z.boolean(),
      maxEventsBeforeCompaction: z.number().int().positive(),
      minEventsPerSummary: z.number().int().positive(),
    }),
    dream: z.object({
      enabled: z.boolean(),
      intervalMinutes: z.number().int().positive(),
      runOnConversationEnd: z.boolean(),
      runOnCompaction: z.boolean(),
      maxHistoryEntriesPerRun: z.number().int().positive(),
      maxIterations: z.number().int().positive(),
      allowEditSoul: z.boolean(),
      allowEditGroup: z.boolean(),
      allowEditUserProfiles: z.boolean(),
    }),
  }),
  tools: z.object({
    workspaceFiles: z.boolean(),
    memory: z.boolean(),
    summarize: z.boolean(),
    weather: z.boolean(),
    discordActions: z.boolean(),
    fetchUrl: z.boolean(),
    readAttachment: z.boolean(),
    sandboxExec: z.boolean(),
    searchInternet: z.boolean(),
  }),
  search: z
    .object({
      provider: z.literal("tavily"),
      apiKey: z.string().min(1),
    })
    .optional(),
  observability: z
    .object({
      langfuse: z.object({
        publicKeyEnv: z.string().min(1).default("LANGFUSE_PUBLIC_KEY"),
        secretKeyEnv: z.string().min(1).default("LANGFUSE_SECRET_KEY"),
        host: z.url().default("https://cloud.langfuse.com"),
      }),
    })
    .optional(),
  sandbox: z.object({
    enabled: z.boolean(),
    network: z.boolean(),
    timeoutMs: z.number().int().positive(),
    outputLimitBytes: z.number().int().positive(),
  }),
});

export type AppConfig = z.infer<typeof configSchema>;

export const defaultConfig: AppConfig = {
  discord: {
    tokenEnv: "DISCORD_BOT_TOKEN",
    allowedGuildIds: [],
    allowedChannelIds: [],
    enableMentions: true,
    enableReplies: true,
    enableReactions: true,
    enableMessageEditStreaming: true,
  },
  llm: {
    provider: "openai-codex",
    model: "gpt-5.5",
    reasoning: "medium",
    codex: {
      authPath: "~/.discord-bot-become-human-2/codex-auth.json",
      transport: "auto",
    },
  },
  runtime: {
    rootDir: "~/.discord-bot-become-human-2",
    defaultLocale: "ko-KR",
    timezone: "Asia/Seoul",
  },
  conversation: {
    maxRecentMessages: 100,
    maxParticipantsForProfileLoad: 16,
    notEngaged: {
      engageDebounceMs: [3000, 9000],
      directTriggerConfidence: 1,
      ambientEngagementEnabled: true,
      ambientMinSilenceMs: 300000,
      ambientConfidenceThreshold: 0.78,
      ambientMaxPerHour: 2,
    },
    engaged: {
      followUpBatch: defaultFollowUpBatchConfig,
      minSecondsBetweenBotReplies: 20,
      minSecondsBetweenUnpromptedReplies: 90,
      maxConsecutiveBotReplies: 1,
      replyConfidenceThreshold: 0.7,
      silentStayConfidenceThreshold: 0.55,
      disengageAfterUnrelatedHumanMessages: 8,
      disengageAfterIdleMs: 900000,
    },
    cooldownMs: [10000, 30000],
  },
  streaming: {
    enabled: true,
    initialPlaceholder: "생각 중...",
    editIntervalMs: 1000,
    softLimitChars: 1800,
    hardLimitChars: 1950,
  },
  context: {
    outputReserveTokens: 16_000,
    safetyBufferTokens: 2_048,
    maxContextMessageChars: 96_000,
    maxTranscriptChars: 64_000,
    maxArchiveSummariesInContext: 8,
    maxArchiveSummaryChars: 12_000,
    maxMemoryChars: 32_000,
    maxUserProfileChars: 16_000,
    maxToolResultChars: 16_000,
    maxFileReadBytes: 131_072,
    maxSearchResultChars: 2_000,
  },
  memory: {
    compaction: {
      enabled: true,
      maxEventsBeforeCompaction: 120,
      minEventsPerSummary: 20,
    },
    dream: {
      enabled: true,
      intervalMinutes: 120,
      runOnConversationEnd: true,
      runOnCompaction: true,
      maxHistoryEntriesPerRun: 20,
      maxIterations: 10,
      allowEditSoul: false,
      allowEditGroup: false,
      allowEditUserProfiles: true,
    },
  },
  tools: {
    workspaceFiles: true,
    memory: true,
    summarize: true,
    weather: true,
    discordActions: true,
    fetchUrl: true,
    readAttachment: true,
    sandboxExec: true,
    searchInternet: true,
  },
  sandbox: {
    enabled: true,
    network: false,
    timeoutMs: 30000,
    outputLimitBytes: 131072,
  },
};

export async function loadOrCreateConfig(configPath: string): Promise<AppConfig> {
  try {
    const raw = await readFile(configPath, "utf8");
    return parseConfig(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(defaultConfig, null, 2)}\n`, "utf8");
  return defaultConfig;
}

export function parseConfig(value: unknown): AppConfig {
  const parsed = configSchema.parse(value);
  if (parsed.streaming.softLimitChars >= parsed.streaming.hardLimitChars) {
    throw new Error("streaming.softLimitChars must be smaller than streaming.hardLimitChars");
  }
  return parsed;
}
