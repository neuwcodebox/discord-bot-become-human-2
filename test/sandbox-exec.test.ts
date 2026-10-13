import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../src/config.js";
import { runDirect } from "../src/tools/bwrap.js";
import { sandboxExec } from "../src/tools/sandbox-exec.js";

const processOptions = {
  workspaceRoot: tmpdir(),
  timeoutMs: 5000,
  outputLimitBytes: 65536,
};
const context = { guildId: "test-guild", workspaceRoot: processOptions.workspaceRoot };
const directConfig = {
  ...defaultConfig,
  sandbox: {
    ...defaultConfig.sandbox,
    enabled: false,
    timeoutMs: processOptions.timeoutMs,
    outputLimitBytes: processOptions.outputLimitBytes,
  },
};

function runCommand(argv: string[], options: Partial<typeof processOptions> = {}) {
  return runDirect({ ...processOptions, ...options, argv });
}

afterEach(() => vi.unstubAllEnvs());

describe("direct process execution", () => {
  it("rejects empty commands", async () => {
    await expect(runCommand([])).rejects.toThrow(/argv must not be empty/);
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
    "/bin/bash",
  ])("blocks shell interpreter %s", async (shell) => {
    await expect(runCommand([shell, "-c", "echo hi"])).rejects.toThrow(/shell interpreters are not allowed/);
  });

  it("returns command output and a successful exit status", async () => {
    const result = await runCommand(["echo", "hello"]);

    expect(result).toMatchObject({ exitCode: 0, timedOut: false });
    expect(result.stdout.trim()).toBe("hello");
  });

  it("returns a command's failed exit status", async () => {
    const result = await runCommand(["false"]);

    expect(result.exitCode).not.toBe(0);
  });

  it("terminates a command that exceeds its timeout", async () => {
    const result = await runCommand(["sleep", "10"], { timeoutMs: 200 });

    expect(result.timedOut).toBe(true);
  });

  it("passes safe environment variables while excluding secrets", async () => {
    vi.stubEnv("MY_TOKEN", "super-secret");
    vi.stubEnv("SAFE_VAR", "safe-value");

    const result = await runCommand(["env"]);

    expect(result.stdout).not.toContain("MY_TOKEN");
    expect(result.stdout).not.toContain("super-secret");
    expect(result.stdout).toContain("SAFE_VAR=safe-value");
  });
});

describe("sandbox disabled", () => {
  it("executes a permitted command directly", async () => {
    const result = await sandboxExec(context, directConfig, { argv: ["echo", "direct"] });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("direct");
  });

  it("continues to block shell interpreters", async () => {
    await expect(sandboxExec(context, directConfig, { argv: ["bash", "-c", "echo hi"] })).rejects.toThrow(
      /shell interpreters are not allowed/,
    );
  });
});
