import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { truncateUtf8 } from "../context/limits.js";

export type SandboxResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  outputLimitBytes: number;
};

const SHELL_DENYLIST = new Set([
  "sh",
  "bash",
  "zsh",
  "fish",
  "dash",
  "ksh",
  "tcsh",
  "csh",
  "cmd",
  "cmd.exe",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
]);

// Strips env vars whose names contain sensitive keywords at underscore boundaries.
function sanitizeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  const SENSITIVE = /(^|_)(TOKEN|KEY|SECRET|PASSWORD|AUTH|CREDENTIAL)(_|$)/i;
  for (const [k, v] of Object.entries(env)) {
    if (!SENSITIVE.test(k)) result[k] = v;
  }
  return result;
}

export async function hasBwrap(): Promise<boolean> {
  const bwrapPath = "/usr/bin/bwrap";
  try {
    await access(bwrapPath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function runBwrap(input: {
  workspaceRoot: string;
  argv: string[];
  timeoutMs: number;
  outputLimitBytes: number;
  network: boolean;
}): Promise<SandboxResult> {
  if (!(await hasBwrap())) throw new Error("sandbox_exec is unavailable because bwrap is not installed.");
  if (input.argv.length === 0) throw new Error("argv must not be empty.");
  const args = [
    "--die-with-parent",
    "--new-session",
    "--unshare-all",
    ...(input.network ? [] : ["--unshare-net"]),
    "--bind",
    input.workspaceRoot,
    input.workspaceRoot,
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
    "--ro-bind",
    "/lib64",
    "/lib64",
    "--",
    ...input.argv,
  ];
  return runProcess("/usr/bin/bwrap", args, input.timeoutMs, input.outputLimitBytes);
}

export async function runDirect(input: {
  workspaceRoot: string;
  argv: string[];
  timeoutMs: number;
  outputLimitBytes: number;
}): Promise<SandboxResult> {
  const command = input.argv[0];
  if (command === undefined) throw new Error("argv must not be empty.");
  const args = input.argv.slice(1);
  const cmdName = path.basename(command).toLowerCase();
  if (SHELL_DENYLIST.has(cmdName)) {
    throw new Error(`sandbox_exec: shell interpreters are not allowed (${cmdName}).`);
  }
  return runProcess(command, args, input.timeoutMs, input.outputLimitBytes, {
    cwd: input.workspaceRoot,
    env: sanitizeEnv(process.env),
  });
}

function runProcess(
  command: string,
  args: string[],
  timeoutMs: number,
  outputLimitBytes: number,
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
): Promise<SandboxResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      const capped = truncateUtf8(stdout + chunk.toString("utf8"), outputLimitBytes);
      stdout = capped.text;
      stdoutTruncated ||= capped.truncated;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const capped = truncateUtf8(stderr + chunk.toString("utf8"), outputLimitBytes);
      stderr = capped.text;
      stderrTruncated ||= capped.truncated;
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      resolve({
        exitCode,
        stdout,
        stderr,
        timedOut,
        stdoutTruncated,
        stderrTruncated,
        outputLimitBytes,
      });
    });
  });
}
