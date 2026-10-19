import type { CodexLlmConfig } from "../config.js";
import { childLogger } from "../logger.js";
import { AgentUnavailableError } from "./availability.js";
import { type CodexUsageSnapshot, fetchCodexUsage } from "./codex-usage-client.js";

const log = childLogger("codex-usage");
export type CodexUsageState = CodexUsageSnapshot & {
  status: "disabled" | "checking" | "available" | "limited" | "unavailable";
};

export class CodexUsageMonitor {
  private state: CodexUsageState;
  private checkedAt: number | undefined;
  private pending: Promise<CodexUsageState> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private readonly controller = new AbortController();
  private readonly listeners = new Set<(state: CodexUsageState) => void>();

  constructor(private readonly codex: CodexLlmConfig["codex"]) {
    this.state = {
      status: codex.usageLimit.enabled ? "checking" : "disabled",
      allowed: !codex.usageLimit.enabled,
      windows: [],
    };
  }

  get current(): CodexUsageState {
    return this.state;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  subscribe(listener: (state: CodexUsageState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (!this.codex.usageLimit.enabled || this.timer || this.controller.signal.aborted) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(true), this.codex.usageLimit.pollIntervalMs);
    this.timer.unref();
  }

  dispose(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.listeners.clear();
    this.controller.abort();
  }

  async assertAvailable(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const state = await this.refresh();
    signal?.throwIfAborted();
    if (!state.allowed) throw new AgentUnavailableError();
  }

  refresh(force = false): Promise<CodexUsageState> {
    if (!this.codex.usageLimit.enabled) return Promise.resolve(this.state);
    if (this.controller.signal.aborted) return Promise.resolve({ ...this.state, allowed: false });
    if (this.pending) return this.pending;
    const now = Date.now();
    const crossedReset = this.state.windows.some(
      (window) =>
        window.resetsAt !== undefined &&
        this.checkedAt !== undefined &&
        this.checkedAt < window.resetsAt &&
        window.resetsAt <= now,
    );
    if (
      this.checkedAt !== undefined &&
      now - this.checkedAt < this.codex.usageLimit.pollIntervalMs &&
      !crossedReset &&
      !force
    )
      return Promise.resolve(this.state);
    this.pending = this.fetchState().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async fetchState(): Promise<CodexUsageState> {
    let next: CodexUsageState;
    try {
      const usage = await fetchCodexUsage(
        this.codex.authPath,
        AbortSignal.any([this.controller.signal, AbortSignal.timeout(10_000)]),
      );
      next = applyUsageLimit(usage, this.codex.usageLimit.minRemainingPercent);
    } catch {
      next = { status: "unavailable", allowed: false, windows: [] };
    }
    if (this.controller.signal.aborted) return { ...next, allowed: false };
    this.checkedAt = Date.now();
    const changed = JSON.stringify(this.state) !== JSON.stringify(next);
    this.state = next;
    if (changed) {
      log.info(
        { status: next.status, remainingPercent: next.remainingPercent, windowCount: next.windows.length },
        "subscription usage state changed",
      );
      for (const listener of this.listeners) listener(next);
    }
    return next;
  }
}

function applyUsageLimit(usage: CodexUsageSnapshot, minRemainingPercent: number): CodexUsageState {
  const remaining = usage.remainingPercent;
  const allowed =
    usage.allowed && (remaining === undefined || (remaining > 0 && remaining >= minRemainingPercent));
  return { ...usage, allowed, status: allowed ? "available" : "limited" };
}
