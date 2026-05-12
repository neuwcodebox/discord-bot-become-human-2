import type { AgentContextMessage, AppConfig } from "../types.js";

export type TruncatedText = {
  text: string;
  truncated: boolean;
  originalLength: number;
  limitChars: number;
};

export type TruncatedBytes = {
  text: string;
  truncated: boolean;
  bytesRead: number;
  limitBytes: number;
};

const truncationMarker = "\n\n... (truncated)";

export function truncateText(value: string, limitChars: number): TruncatedText {
  const originalLength = value.length;
  if (limitChars <= 0) {
    return { text: "", truncated: originalLength > 0, originalLength, limitChars };
  }
  if (originalLength <= limitChars) {
    return { text: value, truncated: false, originalLength, limitChars };
  }
  const keep = Math.max(0, limitChars - truncationMarker.length);
  return {
    text: `${value.slice(0, keep)}${truncationMarker}`,
    truncated: true,
    originalLength,
    limitChars,
  };
}

export function truncateUtf8(value: string, limitBytes: number): TruncatedBytes {
  const bytesRead = Buffer.byteLength(value, "utf8");
  if (limitBytes <= 0) {
    return { text: "", truncated: bytesRead > 0, bytesRead, limitBytes };
  }
  if (bytesRead <= limitBytes) return { text: value, truncated: false, bytesRead, limitBytes };

  const markerBytes = Buffer.byteLength(truncationMarker, "utf8");
  const keepBytes = Math.max(0, limitBytes - markerBytes);
  const buffer = Buffer.from(value, "utf8").subarray(0, keepBytes);
  return {
    text: `${new TextDecoder("utf8", { fatal: false }).decode(buffer)}${truncationMarker}`,
    truncated: true,
    bytesRead,
    limitBytes,
  };
}

export function estimateTokens(value: string): number {
  return Math.ceil(value.length / 4) + 8;
}

export function estimateContextTokens(messages: AgentContextMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateTokens(message.content) + 12, 0);
}

export function promptBudgetTokens(config: AppConfig, contextWindow: number): number {
  const budget = contextWindow - config.context.outputReserveTokens - config.context.safetyBufferTokens;
  return Math.max(1024, budget);
}

export function normalizeContextMessages(
  messages: AgentContextMessage[],
  config: AppConfig,
  contextWindow: number,
): AgentContextMessage[] {
  const perMessageLimit = config.context.maxContextMessageChars;
  const instructions = messages.filter(
    (message) => message.role === "system" || message.role === "developer",
  );
  const conversation = messages.filter(
    (message) => message.role !== "system" && message.role !== "developer",
  );
  const cappedConversation = conversation.map((message) => ({
    ...message,
    content: truncateText(message.content, perMessageLimit).text,
  }));
  const budget = promptBudgetTokens(config, contextWindow);
  if (estimateContextTokens([...instructions, ...cappedConversation]) <= budget) {
    return [...instructions, ...cappedConversation];
  }

  let used = estimateContextTokens(instructions);
  const kept: AgentContextMessage[] = [];
  for (const message of [...cappedConversation].reverse()) {
    const cost = estimateTokens(message.content) + 12;
    if (kept.length > 0 && used + cost > budget) break;
    kept.unshift(message);
    used += cost;
  }
  if (kept.length === 0 && cappedConversation.length > 0) {
    const latest = cappedConversation.at(-1);
    if (latest) {
      const remainingChars = Math.max(512, (budget - used) * 4);
      kept.push({ ...latest, content: truncateText(latest.content, remainingChars).text });
    }
  }
  return [...instructions, ...kept];
}
