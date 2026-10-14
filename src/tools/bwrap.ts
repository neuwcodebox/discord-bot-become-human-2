import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { existingCanonicalPath } from "../paths/canonical-path.js";
import { expandHome } from "../paths/runtime-paths.js";
import type { AppConfig, ToolContext } from "../types.js";
import { SandboxOutput, type SandboxResult } from "./sandbox-output.js";

async function hasBwrap(): Promise<boolean> {
  try {
    await access("/usr/bin/bwrap", constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function bwrapArguments(input: {
  workspaceRoot: string;
  argv: string[];
  network: boolean;
  deniedPaths?: string[];
}): string[] {
  if (!input.argv[0]) throw new Error("argv must not be empty.");
  if (input.argv.some((argument) => argument.includes("\0"))) throw new Error("argv cannot contain NUL.");
  return [
    "--die-with-parent",
    "--new-session",
    "--unshare-all",
    ...(input.network ? ["--share-net"] : []),
    "--clearenv",
    "--setenv",
    "PATH",
    "/usr/local/bin:/usr/bin:/bin",
    "--setenv",
    "HOME",
    input.workspaceRoot,
    "--setenv",
    "TMPDIR",
    "/tmp",
    "--chdir",
    input.workspaceRoot,
    "--ro-bind",
    "/usr",
    "/usr",
    "--ro-bind",
    "/bin",
    "/bin",
    "--ro-bind",
    "/lib",
    "/lib",
    "--ro-bind-try",
    "/lib64",
    "/lib64",
    "--ro-bind-try",
    "/etc/ssl/certs",
    "/etc/ssl/certs",
    "--ro-bind-try",
    "/etc/resolv.conf",
    "/etc/resolv.conf",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    // Mount parents first so a workspace under /tmp or a runtime directory
    // remains visible. Protected-file masks must then override every bind.
    "--bind",
    input.workspaceRoot,
    input.workspaceRoot,
    ...(input.deniedPaths ?? []).flatMap((target) => ["--ro-bind", "/dev/null", target]),
    "--",
    ...input.argv,
  ];
}

async function runBwrap(input: {
  workspaceRoot: string;
  argv: string[];
  timeoutMs: number;
  outputLimitBytes: number;
  network: boolean;
  deniedPaths?: string[];
  signal?: AbortSignal;
}): Promise<SandboxResult> {
  input.signal?.throwIfAborted();
  if (!(await hasBwrap())) throw new Error("sandbox_exec is unavailable because bwrap is not installed.");
  const args = bwrapArguments(input);
  return new Promise((resolve, reject) => {
    input.signal?.throwIfAborted();
    const child = spawn("/usr/bin/bwrap", args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = new SandboxOutput(input.outputLimitBytes);
    const stderr = new SandboxOutput(input.outputLimitBytes);
    let timedOut = false;
    let failure: unknown;
    const cancel = () => {
      child.kill("SIGKILL");
    };
    input.signal?.addEventListener("abort", cancel, { once: true });
    if (input.signal?.aborted) cancel();
    const timeout = setTimeout(() => {
      timedOut = true;
      cancel();
    }, input.timeoutMs);
    child.stdout.on("data", (chunk: unknown) => stdout.append(chunk));
    child.stderr.on("data", (chunk: unknown) => stderr.append(chunk));
    child.stdout.on("error", (error: Error) => {
      failure = error;
      cancel();
    });
    child.stderr.on("error", (error: Error) => {
      failure = error;
      cancel();
    });
    child.on("error", (error: Error) => {
      failure = error;
    });
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", cancel);
      stdout.finish();
      stderr.finish();
      if (failure !== undefined) {
        reject(failure);
        return;
      }
      if (input.signal?.aborted) {
        reject(input.signal.reason);
        return;
      }
      resolve({
        exitCode,
        stdout: stdout.text,
        stderr: stderr.text,
        timedOut,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        outputLimitBytes: input.outputLimitBytes,
      });
    });
  });
}

export async function runLinuxSandbox(
  context: ToolContext,
  config: AppConfig,
  argv: string[],
  signal: AbortSignal,
): Promise<SandboxResult> {
  const workspaceRoot = await realpath(context.workspaceRoot);
  const protectedFiles = [
    join(resolve(expandHome(config.runtime.rootDir)), "config.json"),
    ...(config.llm.provider === "openai-codex" ? [resolve(expandHome(config.llm.codex.authPath))] : []),
    ...(context.protectedPaths ?? []),
  ];
  const deniedPaths: string[] = [];
  for (const candidate of protectedFiles) {
    const canonical = await existingCanonicalPath(candidate);
    if (!canonical) continue;
    const fromWorkspace = relative(workspaceRoot, canonical);
    if (
      fromWorkspace === "" ||
      (fromWorkspace !== ".." && !fromWorkspace.startsWith("../") && !isAbsolute(fromWorkspace))
    ) {
      throw new Error("Sandbox workspace contains protected runtime files.");
    }
    deniedPaths.push(canonical);
  }
  return runBwrap({
    workspaceRoot,
    argv,
    timeoutMs: config.sandbox.timeoutMs,
    outputLimitBytes: config.sandbox.outputLimitBytes,
    network: config.sandbox.network,
    deniedPaths,
    signal,
  });
}
