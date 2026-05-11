import type { AppConfig, ToolContext } from "../types.js";
import { runBwrap } from "./bwrap.js";

export async function sandboxExec(
  context: ToolContext,
  config: AppConfig,
  input: { argv: string[] },
): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  if (!config.sandbox.enabled) throw new Error("sandbox_exec is disabled by config.");
  return runBwrap({
    workspaceRoot: context.workspaceRoot,
    argv: input.argv,
    timeoutMs: config.sandbox.timeoutMs,
    outputLimitBytes: config.sandbox.outputLimitBytes,
    network: config.sandbox.network,
  });
}
