import { win32 } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultConfig, parseConfig } from "../src/config.js";

const host = vi.hoisted(() => ({
  aliases: new Map<string, string>(),
  existing: new Set<string>(),
  realpath: vi.fn<(path: string) => Promise<string>>(),
  mkdir: vi.fn(async () => {}),
  guard: vi.fn<(root: string, path: string) => Promise<string>>(),
}));

vi.mock("node:fs/promises", () => ({
  realpath: (path: string) => host.realpath(path),
  mkdir: () => host.mkdir(),
  stat: async () => ({ isFile: () => true }),
  readdir: async (path: string) =>
    path.endsWith("\\guilds") ? ["guild-a", "guild-b"] : ["workspace", "archive.jsonl"],
}));
vi.mock("../src/paths/workspace-guard.js", () => ({
  assertInsideWorkspace: (root: string, path: string) => host.guard(root, path),
}));

import { prepareWindowsMxcRequest } from "../src/tools/windows-mxc-prepare.js";

const workspaceRoot = "C:\\bot\\guilds\\guild-a\\workspace";
const nodeRoot = "C:\\Program Files\\nodejs";
const executable = `${nodeRoot}\\node.exe`;
const system32 = "C:\\Windows\\System32";
const authPath = "D:\\private\\codex-auth.json";
const instructions = "D:\\source\\resources\\AGENTS.md";
const config = parseConfig({
  ...defaultConfig,
  runtime: { ...defaultConfig.runtime, rootDir: "C:\\bot" },
  llm: {
    provider: "openai-codex",
    model: "gpt-5.5",
    reasoning: "high",
    codex: { authPath, transport: "auto" },
  },
});
const context = { guildId: "guild-a", workspaceRoot, protectedPaths: [instructions] };

beforeEach(() => {
  vi.clearAllMocks();
  host.aliases.clear();
  host.existing = new Set([
    workspaceRoot,
    "C:\\bot",
    "C:\\bot\\config.json",
    authPath,
    instructions,
    nodeRoot,
    executable,
    system32,
    "C:\\bot\\guilds\\guild-b",
    "C:\\bot\\guilds\\guild-a\\archive.jsonl",
  ]);
  host.realpath.mockImplementation(async (path) => {
    if (host.aliases.has(path)) return host.aliases.get(path) ?? path;
    if (host.existing.has(path)) return path;
    throw Object.assign(new Error("missing fixture path"), { code: "ENOENT" });
  });
  host.guard.mockImplementation(async (root, path) => win32.join(root, path));
  vi.spyOn(process, "execPath", "get").mockReturnValue(executable);
  vi.stubEnv("SystemRoot", "C:\\Windows");
  vi.stubEnv("LOCALAPPDATA", "C:\\Users\\Alice\\AppData\\Local");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("Windows host policy preparation", () => {
  it("protects host instructions, external auth, other guilds, and host archive paths", async () => {
    const request = await prepareWindowsMxcRequest(context, config, ["node", "-e", "console.log('ok')"]);
    expect(request.filesystem.readwritePaths).toEqual([workspaceRoot]);
    expect(request.filesystem.readonlyPaths).toEqual([nodeRoot, system32]);
    expect(new Set(request.filesystem.deniedPaths)).toEqual(
      new Set([
        "C:\\bot\\config.json",
        authPath,
        instructions,
        "C:\\bot\\guilds\\guild-b",
        "C:\\bot\\guilds\\guild-a\\archive.jsonl",
      ]),
    );
    expect(request.process.commandLine).toContain(`"${executable}"`);
  });

  it("uses a distinct identity for simultaneous commands in the same guild", async () => {
    const [a, b] = await Promise.all([
      prepareWindowsMxcRequest(context, config, ["node"]),
      prepareWindowsMxcRequest(context, config, ["node"]),
    ]);
    expect(a.containerId).not.toBe(b.containerId);
  });

  it("rejects read-only aliases that expose a protected runtime ancestor", async () => {
    const alias = "D:\\Tools\\alias";
    host.aliases.set(alias, "C:\\bot");
    await expect(
      prepareWindowsMxcRequest(
        context,
        {
          ...config,
          sandbox: { ...config.sandbox, windows: { readonlyPaths: [alias] } },
        },
        ["node"],
      ),
    ).rejects.toThrow();
    expect(host.mkdir).not.toHaveBeenCalled();
  });

  it("rejects executables outside approved paths", async () => {
    const privateExecutable = "D:\\private\\tool.exe";
    await expect(prepareWindowsMxcRequest(context, config, [privateExecutable])).rejects.toThrow(
      "approved runtime",
    );
    expect(host.mkdir).not.toHaveBeenCalled();
  });

  it("rejects a workspace executable junction whose target is outside the policy", async () => {
    host.aliases.set(`${workspaceRoot}\\tool.exe`, "D:\\private\\tool.exe");
    await expect(prepareWindowsMxcRequest(context, config, ["tool.exe"])).rejects.toThrow("approved runtime");
    expect(host.mkdir).not.toHaveBeenCalled();
  });

  it("rejects a mismatched guild workspace", async () => {
    host.existing.add("C:\\bot\\guilds\\guild-b\\workspace");
    await expect(
      prepareWindowsMxcRequest({ ...context, workspaceRoot: "C:\\bot\\guilds\\guild-b\\workspace" }, config, [
        "node",
      ]),
    ).rejects.toThrow("current guild");
  });

  it("refuses preparation when a temporary directory junction escapes the workspace", async () => {
    host.guard.mockRejectedValue(new Error("workspace escape"));
    await expect(prepareWindowsMxcRequest(context, config, ["node"])).rejects.toThrow("workspace escape");
    expect(host.mkdir).not.toHaveBeenCalled();
  });

  it.each(["C:tool.exe", "\\\\server\\share\\tool.exe"])(
    "rejects ambiguous or remote executable %s",
    async (command) => {
      await expect(prepareWindowsMxcRequest(context, config, [command])).rejects.toThrow("unambiguous");
    },
  );

  it("rejects relative operator runtime grants", async () => {
    await expect(
      prepareWindowsMxcRequest(
        context,
        {
          ...config,
          sandbox: { ...config.sandbox, windows: { readonlyPaths: ["relative/tools"] } },
        },
        ["node"],
      ),
    ).rejects.toThrow("absolute Windows");
  });
});
