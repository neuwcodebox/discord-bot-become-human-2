import { mkdir, readFile, readlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { defaultConfig, parseConfig } from "../src/config.js";
import { sandboxExec } from "../src/tools/sandbox-exec.js";
import { createTestWorkspace } from "./helpers/workspace.js";

async function fixture() {
  if (defaultConfig.llm.provider !== "openai-codex") throw new Error("Expected Codex fixture defaults.");
  const runtimeRoot = await createTestWorkspace("dbh2-linux-sandbox-");
  const workspaceRoot = join(runtimeRoot, "guilds", "guild-a", "workspace");
  const otherWorkspace = join(runtimeRoot, "guilds", "guild-b", "workspace");
  await Promise.all([mkdir(workspaceRoot, { recursive: true }), mkdir(otherWorkspace, { recursive: true })]);
  const protectedPath = join(runtimeRoot, "AGENTS.md");
  const otherFile = join(otherWorkspace, "private.txt");
  await Promise.all([
    writeFile(protectedPath, "protected-secret"),
    writeFile(otherFile, "other-guild-secret"),
  ]);
  const config = parseConfig({
    ...defaultConfig,
    runtime: { ...defaultConfig.runtime, rootDir: runtimeRoot },
    llm: {
      ...defaultConfig.llm,
      codex: { ...defaultConfig.llm.codex, authPath: join(runtimeRoot, "auth.json") },
    },
  });
  const context = { guildId: "guild-a", workspaceRoot, protectedPaths: [protectedPath] };
  return { workspaceRoot, protectedPath, otherFile, config, context };
}

describe.skipIf(process.platform !== "linux")("Linux filesystem sandbox", () => {
  it("writes within a /tmp workspace while hiding other guilds and host instructions", async () => {
    const f = await fixture();
    const result = await sandboxExec(f.context, f.config, {
      argv: [
        "/bin/sh",
        "-c",
        'printf workspace-ok > result.txt; test ! -e "$1" && test "$(cat "$2")" != protected-secret',
        "test",
        f.otherFile,
        f.protectedPath,
      ],
    });
    expect(result).toMatchObject({ exitCode: 0, timedOut: false });
    expect(await readFile(join(f.workspaceRoot, "result.txt"), "utf8")).toBe("workspace-ok");
    expect(await readFile(f.protectedPath, "utf8")).toBe("protected-secret");
    expect(await readFile(f.otherFile, "utf8")).toBe("other-guild-secret");
  });

  it("preserves arguments without shell expansion and removes host secrets", async () => {
    const f = await fixture();
    vi.stubEnv("SANDBOX_TEST_TOKEN", "host-secret");
    try {
      const result = await sandboxExec(f.context, f.config, {
        argv: ["/bin/sh", "-c", 'printf "%s|%s|%s" "$1" "$2" "$SANDBOX_TEST_TOKEN"', "test", "a b", "&|$()"],
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("a b|&|$()|");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("shares or isolates networking according to the configured policy", async () => {
    const f = await fixture();
    const hostNamespace = await readlink("/proc/self/ns/net");
    for (const network of [true, false]) {
      const config = { ...f.config, sandbox: { ...f.config.sandbox, network } };
      const result = await sandboxExec(f.context, config, {
        argv: ["/usr/bin/readlink", "/proc/self/ns/net"],
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim() === hostNamespace).toBe(network);
    }
  });

  it("limits output and terminates a command at its timeout", async () => {
    const f = await fixture();
    const config = { ...f.config, sandbox: { ...f.config.sandbox, timeoutMs: 100, outputLimitBytes: 3 } };
    const result = await sandboxExec(f.context, config, {
      argv: ["/bin/sh", "-c", "printf abcdef; sleep 10"],
    });
    expect(result).toMatchObject({ stdout: "abc", stdoutTruncated: true, timedOut: true });
  });
});
