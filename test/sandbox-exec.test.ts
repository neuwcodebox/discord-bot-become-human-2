import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../src/config.js";
import { runDirect } from "../src/tools/bwrap.js";
import { sandboxExec } from "../src/tools/sandbox-exec.js";
import type { AppConfig, ToolContext } from "../src/types.js";

const WORKSPACE = tmpdir();

const context: ToolContext = {
  guildId: "test-guild",
  workspaceRoot: WORKSPACE,
};

function makeConfig(enabled: boolean): AppConfig {
  return {
    ...defaultConfig,
    sandbox: { ...defaultConfig.sandbox, enabled, timeoutMs: 5000, outputLimitBytes: 65536 },
  };
}

describe("runDirect", () => {
  it("rejects empty argv", async () => {
    await expect(
      runDirect({ workspaceRoot: WORKSPACE, argv: [], timeoutMs: 5000, outputLimitBytes: 65536 }),
    ).rejects.toThrow("argv must not be empty");
  });

  it.each([
    "sh",
    "bash",
    "zsh",
    "fish",
    "cmd",
    "cmd.exe",
    "powershell",
    "powershell.exe",
    "pwsh",
    "pwsh.exe",
  ])("blocks shell interpreter: %s", async (shell) => {
    await expect(
      runDirect({
        workspaceRoot: WORKSPACE,
        argv: [shell, "-c", "echo hi"],
        timeoutMs: 5000,
        outputLimitBytes: 65536,
      }),
    ).rejects.toThrow(`shell interpreters are not allowed (${shell})`);
  });

  it("blocks shell by full path", async () => {
    await expect(
      runDirect({
        workspaceRoot: WORKSPACE,
        argv: ["/bin/bash", "-c", "echo hi"],
        timeoutMs: 5000,
        outputLimitBytes: 65536,
      }),
    ).rejects.toThrow("shell interpreters are not allowed (bash)");
  });

  it("runs echo and captures stdout", async () => {
    const result = await runDirect({
      workspaceRoot: WORKSPACE,
      argv: ["echo", "hello"],
      timeoutMs: 5000,
      outputLimitBytes: 65536,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
    expect(result.timedOut).toBe(false);
  });

  it("reports non-zero exit code", async () => {
    const result = await runDirect({
      workspaceRoot: WORKSPACE,
      argv: ["false"],
      timeoutMs: 5000,
      outputLimitBytes: 65536,
    });
    expect(result.exitCode).not.toBe(0);
  });

  it("kills process on timeout and sets timedOut", async () => {
    const result = await runDirect({
      workspaceRoot: WORKSPACE,
      argv: ["sleep", "10"],
      timeoutMs: 200,
      outputLimitBytes: 65536,
    });
    expect(result.timedOut).toBe(true);
  });

  it("does not pass sensitive env vars to child process", async () => {
    vi.stubEnv("MY_TOKEN", "super-secret");
    vi.stubEnv("SAFE_VAR", "safe-value");

    const result = await runDirect({
      workspaceRoot: WORKSPACE,
      argv: ["env"],
      timeoutMs: 5000,
      outputLimitBytes: 65536,
    });

    expect(result.stdout).not.toContain("MY_TOKEN");
    expect(result.stdout).not.toContain("super-secret");
    expect(result.stdout).toContain("SAFE_VAR=safe-value");

    vi.unstubAllEnvs();
  });
});

describe("sandboxExec with sandbox.enabled: false", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs directly without bwrap when disabled", async () => {
    const result = await sandboxExec(context, makeConfig(false), { argv: ["echo", "direct"] });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("direct");
  });

  it("blocks shell interpreters even when sandbox is disabled", async () => {
    await expect(
      sandboxExec(context, makeConfig(false), { argv: ["bash", "-c", "echo hi"] }),
    ).rejects.toThrow("shell interpreters are not allowed");
  });
});
