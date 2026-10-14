import type { AppConfig, ToolContext } from "../types.js";
import { runBwrap, runDirect } from "./bwrap.js";

export async function sandboxExec(
  context: ToolContext,
  config: AppConfig,
  input: { argv: string[] },
  signal?: AbortSignal,
) {
  if (config.sandbox.enabled) {
    return runBwrap({
      workspaceRoot: context.workspaceRoot,
      argv: input.argv,
      timeoutMs: config.sandbox.timeoutMs,
      outputLimitBytes: config.sandbox.outputLimitBytes,
      network: config.sandbox.network,
      ...(signal ? { signal } : {}),
    });
  }
  return runDirect({
    workspaceRoot: context.workspaceRoot,
    argv: input.argv,
    timeoutMs: config.sandbox.timeoutMs,
    outputLimitBytes: config.sandbox.outputLimitBytes,
    ...(signal ? { signal } : {}),
  });
}
