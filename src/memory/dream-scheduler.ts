import type { AgentRunner } from "../agent/runner.js";
import { childLogger } from "../logger.js";
import type { AppConfig, GuildWorkspace } from "../types.js";
import { DreamRunner } from "./dream-runner.js";

const log = childLogger("dream-scheduler");

export class DreamScheduler {
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly config: AppConfig,
    private readonly agentsPath: string,
    private readonly runner: AgentRunner,
  ) {}

  startForGuild(workspace: GuildWorkspace): void {
    if (!this.config.memory.dream.enabled) return;
    if (this.timers.has(workspace.guildId)) return;
    const intervalMs = this.config.memory.dream.intervalMinutes * 60 * 1000;
    const timer = setInterval(() => {
      void this.runNow(workspace, "interval").catch((error) => {
        log.error({ err: error, guildId: workspace.guildId, reason: "interval" }, "dream run failed");
      });
    }, intervalMs);
    timer.unref();
    this.timers.set(workspace.guildId, timer);
    log.info({ guildId: workspace.guildId, intervalMs }, "dream scheduler started");
  }

  async runNow(workspace: GuildWorkspace, reason: string): Promise<void> {
    const startedAt = Date.now();
    log.info({ guildId: workspace.guildId, reason }, "dream run started");
    await new DreamRunner(
      workspace.workspaceRoot,
      this.agentsPath,
      workspace.guildId,
      this.config,
      this.runner,
    ).run(reason);
    log.info(
      { guildId: workspace.guildId, reason, durationMs: Date.now() - startedAt },
      "dream run completed",
    );
  }

  stopAll(): void {
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
  }
}
