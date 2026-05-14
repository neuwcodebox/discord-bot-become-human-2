import type { AfterToolCallResult, AgentMessage, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Agent } from "@earendil-works/pi-agent-core";
import { getModels, registerBuiltInApiProviders } from "@earendil-works/pi-ai";
import type { Langfuse } from "langfuse";
import type { CodexLlmConfig, OpenAICompatLlmConfig } from "../config.js";
import { normalizeContextMessages, truncateText } from "../context/limits.js";
import { childLogger } from "../logger.js";
import { createLangfuseAgentObserver, summarizeAgentToolActivity } from "../observability/langfuse.js";
import type { AgentRunRequest, AgentRunResult, AppConfig, RuntimeModel } from "../types.js";
import { loadCodexCredentials } from "./provider.js";

const log = childLogger("agent-runner");

type CodexAppConfig = Omit<AppConfig, "llm"> & { llm: CodexLlmConfig };
type OpenAICompatAppConfig = Omit<AppConfig, "llm"> & { llm: OpenAICompatLlmConfig };

export interface AgentRunner {
  run(request: AgentRunRequest): Promise<AgentRunResult>;
}

export class PiCodexAgentRunner implements AgentRunner {
  constructor(
    private readonly config: CodexAppConfig,
    private readonly langfuse?: Langfuse | null,
  ) {
    registerBuiltInApiProviders();
  }

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const startedAt = Date.now();
    const model = resolveCodexModel(this.config);
    const messages = normalizeContextMessages(request.messages, this.config, model.contextWindow);
    const credentials = await loadCodexCredentials(this.config.llm.codex.authPath);
    if (!credentials.apiKey) {
      throw new Error(
        `Codex auth is not available at ${this.config.llm.codex.authPath}. Run: npm run login:codex`,
      );
    }

    return runAgent(request, this.config, model, {
      getApiKey: async () => credentials.apiKey,
      transport: this.config.llm.codex.transport === "websocket" ? "websocket" : "auto",
      thinkingLevel: this.config.llm.reasoning,
      messages,
      startedAt,
      langfuse: this.langfuse ?? null,
    });
  }
}

export class OpenAICompatibleAgentRunner implements AgentRunner {
  constructor(
    private readonly config: OpenAICompatAppConfig,
    private readonly langfuse?: Langfuse | null,
  ) {
    registerBuiltInApiProviders();
  }

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const startedAt = Date.now();
    const model: RuntimeModel = {
      id: this.config.llm.model,
      name: this.config.llm.model,
      api: "openai-completions",
      provider: "openai-compatible",
      baseUrl: this.config.llm.baseURL,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: this.config.llm.contextWindow,
      maxTokens: this.config.context.outputReserveTokens,
    };
    const messages = normalizeContextMessages(request.messages, this.config, model.contextWindow);

    const apiKeyEnv = this.config.llm.apiKeyEnv;
    const apiKey = process.env[apiKeyEnv];
    if (!apiKey) throw new Error(`Environment variable ${apiKeyEnv} is not set`);

    return runAgent(request, this.config, model, {
      getApiKey: async () => apiKey,
      thinkingLevel: this.config.llm.reasoning,
      messages,
      startedAt,
      langfuse: this.langfuse ?? null,
    });
  }
}

type RunAgentOptions = {
  getApiKey: () => Promise<string | undefined>;
  transport?: "auto" | "websocket";
  thinkingLevel: "low" | "medium" | "high" | "xhigh";
  messages: ReturnType<typeof normalizeContextMessages>;
  startedAt: number;
  langfuse: Langfuse | null;
};

async function runAgent(
  request: AgentRunRequest,
  config: AppConfig,
  model: RuntimeModel,
  opts: RunAgentOptions,
): Promise<AgentRunResult> {
  const { messages, startedAt, langfuse } = opts;

  const langfuseObserver = langfuse
    ? createLangfuseAgentObserver({
        langfuse,
        ...(request.traceLabel !== undefined ? { traceLabel: request.traceLabel } : {}),
        sessionId: request.sessionId,
        model: model.id,
        provider: model.provider,
        inputMessages: messages,
        startedAt,
      })
    : null;

  const normalizedSystemPrompt = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
  const prompts: AgentMessage[] = messages
    .filter((message) => message.role === "user")
    .map((message) => ({
      role: "user",
      content: [{ type: "text", text: message.content }],
      timestamp: Date.now(),
    }));

  const agent = new Agent({
    sessionId: request.sessionId,
    initialState: {
      systemPrompt: normalizedSystemPrompt,
      model,
      thinkingLevel: opts.thinkingLevel,
      tools: request.tools ?? [],
    },
    getApiKey: opts.getApiKey,
    ...(opts.transport !== undefined ? { transport: opts.transport } : {}),
    afterToolCall: async (context) => normalizeToolResult(context.result, config.context.maxToolResultChars),
  });
  log.info(
    {
      sessionId: request.sessionId,
      model: model.id,
      provider: model.provider,
      reasoning: opts.thinkingLevel,
      messageCount: messages.length,
      estimatedContextWindow: model.contextWindow,
      toolCount: request.tools?.length ?? 0,
      streaming: Boolean(request.onTextDelta),
    },
    "agent run started",
  );

  let finalText = "";
  let currentAssistantText = "";
  agent.subscribe(async (event) => {
    await langfuseObserver?.handleEvent(event);
    if (event.type === "message_start" && event.message.role === "assistant") {
      currentAssistantText = "";
      return;
    }
    if (event.type === "message_update") {
      if (event.assistantMessageEvent.type === "text_delta") {
        currentAssistantText += event.assistantMessageEvent.delta;
        finalText = currentAssistantText;
        await request.onTextDelta?.(event.assistantMessageEvent.delta);
        return;
      }
      const text = extractAssistantText(event.message);
      const delta = text.startsWith(currentAssistantText) ? text.slice(currentAssistantText.length) : text;
      currentAssistantText = text;
      finalText = text;
      if (delta) await request.onTextDelta?.(delta);
      return;
    }
    if (event.type !== "message_end" || event.message.role !== "assistant") return;
    const text = extractAssistantText(event.message);
    currentAssistantText = text;
    finalText = text;
  });

  await agent.prompt(prompts);
  await agent.waitForIdle();
  if (!request.allowEmptyText && finalText.trim().length === 0) {
    const latestAssistant = findLatestAssistantMessage(agent.state.messages);
    const stateText = latestAssistant ? extractAssistantText(latestAssistant) : "";
    if (stateText.trim().length > 0) {
      finalText = stateText;
    } else {
      log.warn(
        {
          sessionId: request.sessionId,
          ...summarizeAssistantMessage(latestAssistant),
        },
        "agent run produced empty text",
      );
    }
  }
  const durationMs = Date.now() - startedAt;
  const toolActivity = summarizeAgentToolActivity(agent.state.messages);
  langfuseObserver?.finish(finalText, agent.state.messages);
  log.info(
    {
      sessionId: request.sessionId,
      durationMs,
      outputLength: finalText.length,
      transcriptMessageCount: agent.state.messages.length,
      ...toolActivity,
    },
    "agent run completed",
  );
  return {
    text: finalText,
    messages: agent.state.messages,
  };
}

function normalizeToolResult(
  result: AgentToolResult<unknown>,
  maxChars: number,
): AfterToolCallResult | undefined {
  let changed = false;
  const content = result.content.map((part) => {
    if (part.type !== "text" || typeof part.text !== "string") return part;
    const capped = truncateText(part.text, maxChars);
    if (!capped.truncated) return part;
    changed = true;
    return { ...part, text: capped.text };
  });
  if (!changed) return undefined;
  return {
    content,
    details: {
      originalDetails: result.details,
      truncated: true,
      limitChars: maxChars,
    },
    ...(result.terminate !== undefined ? { terminate: result.terminate } : {}),
  };
}

export class StaticAgentRunner implements AgentRunner {
  constructor(private readonly text: string) {}

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    await request.onTextDelta?.(this.text);
    return { text: this.text };
  }
}

function resolveCodexModel(config: CodexAppConfig): RuntimeModel {
  const model = getModels("openai-codex").find((candidate) => candidate.id === config.llm.model);
  if (!model) throw new Error(`Unknown openai-codex model: ${config.llm.model}`);
  return model;
}

function extractAssistantText(message: AgentMessage): string {
  if (message.role !== "assistant") return "";
  return message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .filter(Boolean)
    .join("");
}

function findLatestAssistantMessage(
  messages: AgentMessage[],
): Extract<AgentMessage, { role: "assistant" }> | undefined {
  return messages.findLast((message): message is Extract<AgentMessage, { role: "assistant" }> => {
    return message.role === "assistant";
  });
}

function summarizeAssistantMessage(message: Extract<AgentMessage, { role: "assistant" }> | undefined): {
  stopReason?: string;
  errorMessage?: string;
  contentTypes?: string[];
  textPartCount?: number;
  textLength?: number;
  thinkingPartCount?: number;
  toolCallNames?: string[];
} {
  if (!message) return {};
  const textParts = message.content.filter((part) => part.type === "text");
  const thinkingParts = message.content.filter((part) => part.type === "thinking");
  const toolCalls = message.content.filter((part) => part.type === "toolCall");
  const summary: ReturnType<typeof summarizeAssistantMessage> = {
    stopReason: message.stopReason,
    contentTypes: message.content.map((part) => part.type),
    textPartCount: textParts.length,
    textLength: textParts.reduce((sum, part) => sum + part.text.length, 0),
    thinkingPartCount: thinkingParts.length,
    toolCallNames: toolCalls.map((part) => part.name),
  };
  if (message.errorMessage) summary.errorMessage = message.errorMessage;
  return summary;
}
