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

/** Apply one character budget without erasing stable message boundaries. */
export function truncateTextParts(parts: string[], limitChars: number): string[] {
  const combined = parts.join("\n\n");
  const capped = truncateText(combined, limitChars);
  if (!capped.truncated) return parts.slice();
  if (!capped.text) return [];
  const prefix = combined.slice(0, Math.max(0, limitChars - truncationMarker.length));
  let offset = 0;
  const kept: string[] = [];
  for (const [index, part] of parts.entries()) {
    if (index > 0) {
      if (offset + 2 >= prefix.length) {
        const last = kept.length - 1;
        if (last >= 0) kept[last] = `${kept[last]}${prefix.slice(offset)}`;
        break;
      }
      offset += 2;
    }
    if (offset >= prefix.length) break;
    kept.push(prefix.slice(offset, offset + part.length));
    offset += part.length;
  }
  if (kept.length === 0) return [truncationMarker];
  const last = kept.length - 1;
  kept[last] = `${kept[last]}${truncationMarker}`;
  return kept;
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
  // A split observation is still one logical budget unit. Splitting it into API
  // messages must not multiply maxContextMessageChars or alter which older units
  // are discarded. Developer instructions remain protected in their own position.
  const groups: AgentContextMessage[][] = [];
  for (const message of messages) {
    const previous = groups.at(-1);
    if (
      message.budgetGroup &&
      previous?.[0]?.budgetGroup === message.budgetGroup &&
      previous.every((entry) => entry.role === message.role)
    ) {
      previous.push(message);
    } else {
      groups.push([message]);
    }
  }
  const instruction = (group: AgentContextMessage[]) =>
    group.every((message) => message.role === "system" || message.role === "developer");
  const capped = groups.map((group) => {
    if (instruction(group)) return group;
    const parts = truncateTextParts(
      group.map((message) => message.content),
      config.context.maxContextMessageChars,
    );
    return parts.flatMap((content, index) => {
      const original = group[index];
      return original ? [{ ...original, content }] : [];
    });
  });
  const budget = promptBudgetTokens(config, contextWindow);
  if (estimateContextTokens(capped.flat()) <= budget) return capped.flat();

  let used = estimateContextTokens(capped.filter(instruction).flat());
  const kept = new Set<AgentContextMessage[]>();
  for (const group of [...capped].reverse()) {
    if (instruction(group)) continue;
    const cost = estimateContextTokens(group);
    if (kept.size > 0 && used + cost > budget) break;
    kept.add(group);
    used += cost;
  }
  return capped.filter((group) => instruction(group) || kept.has(group)).flat();
}
