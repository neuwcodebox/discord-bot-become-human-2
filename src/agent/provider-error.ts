/** Provider diagnostics are operational metadata, never a Discord reply. */
export function sanitizeProviderError(message: string | undefined): string {
  if (!message?.trim()) return "Model provider ended the request with an error (no details supplied).";
  return message
    .replace(/\\"/g, '"')
    .replace(/data:[^\s"']+/gi, "[REDACTED_DATA]")
    .replace(/https?:\/\/[^\s"']+/gi, "[REDACTED_URL]")
    .replace(/\bBearer\s+[^\s,;"']+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[a-zA-Z0-9_-]+/g, "[REDACTED]")
    .replace(
      /(["']?(?:api[_-]?key|authorization|[a-z_]*token|refresh|password|[a-z_]*secret)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,
      "$1[REDACTED]",
    )
    .replace(/\s+/g, " ")
    .slice(0, 1_000);
}

export class AgentProviderError extends Error {
  constructor(detail?: string) {
    super(sanitizeProviderError(detail));
    this.name = "AgentProviderError";
  }
}
