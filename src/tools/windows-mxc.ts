import type { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { childLogger } from "../logger.js";
import type { AppConfig, ToolContext } from "../types.js";
import { loadMxcRuntime, type MxcRuntime } from "./mxc-native.js";
import { SandboxOutput, type SandboxResult } from "./sandbox-output.js";
import type { WindowsMxcRequest } from "./windows-mxc-policy.js";
import { prepareWindowsMxcRequest } from "./windows-mxc-prepare.js";

const log = childLogger("windows-sandbox");

async function consume(stream: Readable | null, output: SandboxOutput): Promise<void> {
  if (stream) for await (const chunk of stream) output.append(chunk);
  output.finish();
}

export async function executeWindowsMxcRequest(
  request: WindowsMxcRequest,
  outputLimitBytes: number,
  signal?: AbortSignal,
  native?: MxcRuntime,
): Promise<SandboxResult> {
  signal?.throwIfAborted();
  const engine = native ?? loadMxcRuntime();
  const requestJson = JSON.stringify(request);
  const support = engine.probe(requestJson);
  if (support.error || support.tier !== "appcontainer-dacl") {
    throw new Error("Windows MXC cannot enforce the required LPAC filesystem policy on this host.", {
      ...(support.error ? { cause: new Error(support.error) } : {}),
    });
  }
  if (support.warnings.some((warning) => warning.includes("wxc-host-prep"))) {
    throw new Error(
      "Windows MXC host preparation is required. Run npm run sandbox:prepare in an administrator terminal after reboot.",
    );
  }
  signal?.throwIfAborted();
  const child = await engine.spawn(requestJson);
  const stdout = new SandboxOutput(outputLimitBytes);
  const stderr = new SandboxOutput(outputLimitBytes);
  let outputError: unknown;
  let killError: unknown;
  let killRequested = false;
  let timedOut = false;
  const startedAt = performance.now();
  const outputDone = Promise.all([consume(child.stdout, stdout), consume(child.stderr, stderr)]);
  // Attach immediately: pipe errors must terminate execution, not become an
  // unhandled rejection while the caller is polling the native handle.
  void outputDone.catch((error: unknown) => {
    outputError = error;
  });
  const cancel = () => {
    if (killRequested) return;
    killRequested = true;
    try {
      child.kill(false);
    } catch (error) {
      killError = error;
    }
  };
  signal?.addEventListener("abort", cancel, { once: true });
  let completed = false;
  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= child.close();
    return closing;
  };
  try {
    // Also handles cancellation that arrived during native spawn.
    if (signal?.aborted) cancel();
    while (true) {
      if (killError !== undefined) throw killError;
      if (outputError !== undefined) throw outputError;
      signal?.throwIfAborted();
      const state = child.poll();
      if (!state.running) {
        timedOut ||= state.timedOut;
        // Free ends the job/process tree and restores ACLs. Do this before
        // waiting for EOF so descendants cannot keep output pipes open.
        signal?.removeEventListener("abort", cancel);
        await close();
        completed = true;
        await outputDone;
        signal?.throwIfAborted();
        return {
          exitCode: state.exitCode,
          stdout: stdout.text,
          stderr: stderr.text,
          timedOut,
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
          outputLimitBytes,
        };
      }
      if (!killRequested && performance.now() - startedAt >= request.process.timeout) {
        timedOut = true;
        killRequested = true;
        child.kill(true);
      }
      await delay(25);
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    if (!completed) {
      try {
        await close();
      } finally {
        child.stdout?.destroy();
        child.stderr?.destroy();
        await outputDone.catch(() => {});
      }
    }
  }
}

export async function runWindowsMxc(
  context: ToolContext,
  config: AppConfig,
  argv: string[],
  signal?: AbortSignal,
): Promise<SandboxResult> {
  signal?.throwIfAborted();
  const startedAt = performance.now();
  const request = await prepareWindowsMxcRequest(context, config, argv);
  const result = await executeWindowsMxcRequest(request, config.sandbox.outputLimitBytes, signal);
  log.debug(
    {
      guildId: context.guildId,
      backend: "appcontainer-dacl",
      durationMs: Math.round(performance.now() - startedAt),
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      stdoutBytes: Buffer.byteLength(result.stdout),
      stderrBytes: Buffer.byteLength(result.stderr),
    },
    "sandbox execution completed",
  );
  return result;
}
