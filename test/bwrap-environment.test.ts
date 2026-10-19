import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runBwrap } from "../src/tools/bwrap.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, access: vi.fn().mockResolvedValue(undefined) };
});
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, spawn: vi.fn(original.spawn) };
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("bwrap execution environment", () => {
  it("does not expose host credentials even under arbitrary environment variable names", async () => {
    vi.stubEnv("DISCORD_BOT_TOKEN", "test-discord-secret");
    vi.stubEnv("CUSTOM_PROVIDER_LOGIN", "test-arbitrary-secret");
    const original = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    // Probe the exact child environment without requiring host user-namespace support.
    vi.mocked(spawn).mockImplementation((_command, _args, options) =>
      original.spawn("/usr/bin/env", [], options),
    );

    const result = await runBwrap({
      workspaceRoot: "/unused-guild",
      argv: ["env"],
      timeoutMs: 5000,
      outputLimitBytes: 65536,
      network: false,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("test-discord-secret");
    expect(result.stdout).not.toContain("test-arbitrary-secret");
    expect(spawn).toHaveBeenCalledWith(
      "/usr/bin/bwrap",
      expect.arrayContaining(["--unshare-all", "--bind", "/unused-guild"]),
      expect.objectContaining({ env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" } }),
    );
    expect(result.stdout.trim().split("\n").sort()).toEqual(["LANG=C.UTF-8", "PATH=/usr/bin:/bin"]);
  });
});
