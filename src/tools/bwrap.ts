import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";

export async function hasBwrap(): Promise<boolean> {
  const path = "/usr/bin/bwrap";
  try {
    await access(path, constants.X_OK);
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
}): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> {
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

function runProcess(
  command: string,
  args: string[],
  timeoutMs: number,
  outputLimitBytes: number,
): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = capString(stdout + chunk.toString("utf8"), outputLimitBytes);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = capString(stderr + chunk.toString("utf8"), outputLimitBytes);
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      resolve({
        exitCode,
        stdout,
        stderr,
        timedOut,
      });
    });
  });
}

function capString(value: string, limit: number): string {
  return Buffer.byteLength(value, "utf8") <= limit ? value : value.slice(0, limit);
}
