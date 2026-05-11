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
    agent.subscribe(async (event) => {
      if (event.type !== "message_update" && event.type !== "message_end") return;
      const text = extractAssistantText(event.message);
      if (event.type === "message_update") {
        const delta = text.slice(finalText.length);
        if (delta) await request.onTextDelta?.(delta);
      }
      finalText = text;
    });

    await agent.prompt(prompts);
    await agent.waitForIdle();
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
