import type { Agent } from "@earendil-works/pi-agent-core";
import type { AgentRunRequest } from "../types.js";

/** Bind external cancellation and steering to one pi run, never to a later run. */
export function bindAgentRunControl(
  agent: Pick<Agent, "abort" | "steer">,
  request: AgentRunRequest,
): () => void {
  request.signal?.throwIfAborted();
  let accepting = true;
  const abort = () => agent.abort();
  request.signal?.addEventListener("abort", abort, { once: true });
  request.onControlReady?.({
    steer(contents) {
      if (!accepting || request.signal?.aborted) return false;
      agent.steer({ role: "user", content: [{ type: "text", text: contents }], timestamp: Date.now() });
      return true;
    },
  });
  return () => {
    accepting = false;
    request.signal?.removeEventListener("abort", abort);
  };
}
