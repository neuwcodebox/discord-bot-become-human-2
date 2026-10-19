/** A temporary runtime gate, rather than a failed model generation. */
export class AgentUnavailableError extends Error {
  constructor() {
    super("Bot paused by the Codex subscription usage limit.");
    this.name = "AgentUnavailableError";
  }
}
