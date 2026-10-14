import { describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../src/config.js";
import { SandboxExecutor } from "../src/tools/sandbox-exec.js";
import type { SandboxResult } from "../src/tools/sandbox-output.js";
import type { AppConfig, ToolContext } from "../src/types.js";

const context = { guildId: "guild-a", workspaceRoot: "/workspace" };
const command = { argv: ["node", "script.js", "a b", "&|$()"] };
const result: SandboxResult = {
  exitCode: 0,
  stdout: "ok",
  stderr: "",
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  outputLimitBytes: 131072,
};

describe("sandbox command lifecycle", () => {
  it("preserves command arguments, policy, and the backend result", async () => {
    const backend = vi.fn(async () => result);
    const executor = new SandboxExecutor(backend);
    expect(await executor.run(context, defaultConfig, command)).toEqual(result);
    expect(backend).toHaveBeenCalledWith(context, defaultConfig, command.argv, expect.any(AbortSignal));
  });

  it.each([
    { ...defaultConfig, sandbox: { ...defaultConfig.sandbox, enabled: false } },
    { ...defaultConfig, tools: { ...defaultConfig.tools, sandboxExec: false } },
  ])("does not execute disabled commands", async (config) => {
    const backend = vi.fn(async () => result);
    await expect(new SandboxExecutor(backend).run(context, config, command)).rejects.toThrow("disabled");
    expect(backend).not.toHaveBeenCalled();
  });

  it.each([{ argv: [] }, { argv: [""] }, { argv: ["node", "a\0b"] }])(
    "rejects invalid argv $argv without executing",
    async ({ argv }) => {
      const backend = vi.fn(async () => result);
      await expect(new SandboxExecutor(backend).run(context, defaultConfig, { argv })).rejects.toThrow();
      expect(backend).not.toHaveBeenCalled();
    },
  );

  it("rejects a pre-cancelled command without executing", async () => {
    const backend = vi.fn(async () => result);
    const controller = new AbortController();
    controller.abort();
    await expect(
      new SandboxExecutor(backend).run(context, defaultConfig, command, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(backend).not.toHaveBeenCalled();
  });

  it("propagates backend failure without retrying outside isolation", async () => {
    const error = new Error("isolation unavailable");
    const backend = vi.fn(async () => {
      throw error;
    });
    await expect(new SandboxExecutor(backend).run(context, defaultConfig, command)).rejects.toBe(error);
    expect(backend).toHaveBeenCalledOnce();
  });

  it("refuses commands on unsupported operating systems", async () => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    try {
      await expect(new SandboxExecutor().run(context, defaultConfig, command)).rejects.toThrow(
        "Linux and Windows only",
      );
    } finally {
      platform.mockRestore();
    }
  });

  it("forwards cancellation and waits for backend cleanup before rejecting", async () => {
    const cleanup = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<void>();
    const executor = new SandboxExecutor(async (_context, _config, _argv, signal) => {
      signal.addEventListener("abort", () => cancelled.resolve(), { once: true });
      await cleanup.promise;
      signal.throwIfAborted();
      return result;
    });
    const controller = new AbortController();
    const running = executor.run(context, defaultConfig, command, controller.signal);
    const rejected = expect(running).rejects.toMatchObject({ name: "AbortError" });
    let settled = false;
    void running.catch(() => {
      settled = true;
    });
    controller.abort();
    await cancelled.promise;
    expect(settled).toBe(false);
    cleanup.resolve();
    await rejected;
  });

  it("shutdown cancels all pending commands, waits for cleanup, and rejects new work", async () => {
    const firstCleanup = Promise.withResolvers<void>();
    const secondCleanup = Promise.withResolvers<void>();
    const cleanups = [firstCleanup, secondCleanup];
    const cancelled: string[] = [];
    let next = 0;
    const backend = async (
      _context: ToolContext,
      _config: AppConfig,
      argv: string[],
      signal: AbortSignal,
    ) => {
      const cleanup = cleanups[next++];
      if (!cleanup) throw new Error("Unexpected command.");
      signal.addEventListener("abort", () => cancelled.push(argv.join(" ")), { once: true });
      await cleanup.promise;
      signal.throwIfAborted();
      return result;
    };
    const executor = new SandboxExecutor(backend);
    const running = [
      executor.run(context, defaultConfig, { argv: ["first"] }),
      executor.run(context, defaultConfig, { argv: ["second"] }),
    ];
    const rejected = running.map((command) => expect(command).rejects.toMatchObject({ name: "AbortError" }));
    let finished = false;
    const shutdown = executor.shutdown().then(() => {
      finished = true;
    });
    expect(new Set(cancelled)).toEqual(new Set(["first", "second"]));
    await expect(executor.run(context, defaultConfig, command)).rejects.toThrow("shutdown");
    firstCleanup.resolve();
    await rejected[0];
    expect(finished).toBe(false);
    secondCleanup.resolve();
    await Promise.all(rejected);
    await shutdown;
    expect(finished).toBe(true);
  });

  it("shutdown reports cleanup failures", async () => {
    const cleanup = Promise.withResolvers<SandboxResult>();
    const executor = new SandboxExecutor(() => cleanup.promise);
    const running = executor.run(context, defaultConfig, command);
    const rejected = expect(running).rejects.toThrow("cleanup failed");
    const shutdown = expect(executor.shutdown()).rejects.toThrow("shutdown cleanup");
    cleanup.reject(new Error("cleanup failed"));
    await Promise.all([rejected, shutdown]);
  });

  it("completed commands do not prevent later shutdown or affect another executor", async () => {
    const executor = new SandboxExecutor(async () => result);
    await executor.run(context, defaultConfig, command);
    await executor.shutdown();
    await expect(
      new SandboxExecutor(async () => result).run(context, defaultConfig, command),
    ).resolves.toEqual(result);
  });
});
