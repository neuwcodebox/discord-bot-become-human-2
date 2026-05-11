import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Agent } from "@earendil-works/pi-agent-core";
import { getModels, registerBuiltInApiProviders } from "@earendil-works/pi-ai";
import { childLogger } from "../logger.js";
import type { AgentRunRequest, AgentRunResult, AppConfig, RuntimeModel } from "../types.js";
import { loadCodexCredentials } from "./provider.js";

const log = childLogger("agent-runner");

export interface AgentRunner {
  run(request: AgentRunRequest): Promise<AgentRunResult>;
}

export class PiCodexAgentRunner implements AgentRunner {
  constructor(private readonly config: AppConfig) {
    registerBuiltInApiProviders();
  }

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const startedAt = Date.now();
    const model = resolveModel(this.config);
    const credentials = await loadCodexCredentials(this.config);
    if (!credentials.apiKey) {
      throw new Error(
        `Codex auth is not available at ${this.config.llm.codex.authPath}. Run: npm run login:codex`,
      );
    }

    const systemPrompt = request.messages
      .filter((message) => message.role === "system" || message.role === "developer")
      .map((message) => message.content)
      .join("\n\n");
    const prompts: AgentMessage[] = request.messages
      .filter((message) => message.role === "user")
      .map((message) => ({
        role: "user",
        content: [{ type: "text", text: message.content }],
        timestamp: Date.now(),
      }));

    const agent = new Agent({
      sessionId: request.sessionId,
      initialState: {
        systemPrompt,
        model,
        thinkingLevel: this.config.llm.reasoning,
        tools: request.tools ?? [],
      },
      getApiKey: async () => credentials.apiKey,
      transport: this.config.llm.codex.transport === "websocket" ? "websocket" : "auto",
    });
    log.info(
      {
        sessionId: request.sessionId,
        model: model.id,
        reasoning: this.config.llm.reasoning,
        messageCount: request.messages.length,
        toolCount: request.tools?.length ?? 0,
        streaming: Boolean(request.onTextDelta),
      },
      "agent run started",
    );

    let finalText = "";
    let currentAssistantText = "";
    agent.subscribe(async (event) => {
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
    log.info(
      {
        sessionId: request.sessionId,
        durationMs: Date.now() - startedAt,
        outputLength: finalText.length,
        transcriptMessageCount: agent.state.messages.length,
      },
      "agent run completed",
    );
    return {
      text: finalText,
      messages: agent.state.messages,
    };
  }
}

export class StaticAgentRunner implements AgentRunner {
  constructor(private readonly text: string) {}

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    await request.onTextDelta?.(this.text);
    return { text: this.text };
  }
}

function resolveModel(config: AppConfig): RuntimeModel {
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
