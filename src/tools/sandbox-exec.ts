import type { AppConfig, ToolContext } from "../types.js";
import { runLinuxSandbox } from "./bwrap.js";
import type { SandboxResult } from "./sandbox-output.js";

type SandboxBackend = (
  context: ToolContext,
  config: AppConfig,
  argv: string[],
  signal: AbortSignal,
) => Promise<SandboxResult>;

async function runSandboxBackend(
  context: ToolContext,
  config: AppConfig,
  argv: string[],
  signal: AbortSignal,
): Promise<SandboxResult> {
  if (process.platform === "win32") {
    const { runWindowsMxc } = await import("./windows-mxc.js");
    return runWindowsMxc(context, config, argv, signal);
  }
  if (process.platform === "linux") return runLinuxSandbox(context, config, argv, signal);
  throw new Error("sandbox_exec supports Linux and Windows only.");
}

/** Owns in-flight commands so shutdown waits for the backend's resource cleanup. */
export class SandboxExecutor {
  private readonly active = new Map<AbortController, Promise<SandboxResult>>();
  private stopping = false;

  constructor(private readonly backend: SandboxBackend = runSandboxBackend) {}

  async run(
    context: ToolContext,
    config: AppConfig,
    input: { argv: string[] },
    signal?: AbortSignal,
  ): Promise<SandboxResult> {
    if (!config.sandbox.enabled || !config.tools.sandboxExec) throw new Error("sandbox_exec is disabled.");
    if (this.stopping) throw new Error("sandbox_exec is unavailable during shutdown.");
    signal?.throwIfAborted();
    if (!input.argv[0]) throw new Error("argv must not be empty.");
    if (input.argv.some((argument) => argument.includes("\0"))) throw new Error("argv cannot contain NUL.");
    const controller = new AbortController();
    const executionSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const execution = this.backend(context, config, input.argv, executionSignal);
    this.active.set(controller, execution);
    try {
      return await execution;
    } finally {
      this.active.delete(controller);
    }
  }

  /** Abort every launch, including one still preparing its native container. */
  async shutdown(): Promise<void> {
    this.stopping = true;
    const executions = [...this.active.values()];
    for (const controller of this.active.keys()) controller.abort();
    const results = await Promise.allSettled(executions);
    const failures = results.filter(
      (result) =>
        result.status === "rejected" &&
        !(result.reason instanceof Error && result.reason.name === "AbortError"),
    );
    if (failures.length > 0)
      throw new Error(`${failures.length} sandbox executions failed during shutdown cleanup.`);
  }
}

const executor = new SandboxExecutor();

export function sandboxExec(
  context: ToolContext,
  config: AppConfig,
  input: { argv: string[] },
  signal?: AbortSignal,
): Promise<SandboxResult> {
  return executor.run(context, config, input, signal);
}

export function shutdownSandboxExecutions(): Promise<void> {
  return executor.shutdown();
}
