import { win32 } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({
  aliases: new Map<string, string>(),
  existing: new Set<string>(),
  dangling: new Set<string>(),
  config: {},
  run: vi.fn(async (_command: string, _args: string[]) => {}),
}));
vi.mock("node:fs/promises", () => ({
  realpath: async (path: string) => {
    const alias = host.aliases.get(path);
    if (alias) return alias;
    if (host.existing.has(path)) return path;
    throw Object.assign(new Error("missing"), { code: "ENOENT" });
  },
  lstat: async (path: string) => {
    if (host.dangling.has(path)) return { isSymbolicLink: () => true };
    throw Object.assign(new Error("missing"), { code: "ENOENT" });
  },
}));
vi.mock("../src/config.js", () => ({ loadOrCreateConfig: async () => host.config }));
vi.mock("../src/paths/runtime-paths.js", () => ({
  expandHome: (path: string) => path,
  createRuntimePaths: () => ({
    runtimeRoot: "C:\\bot",
    configPath: "C:\\bot\\config.json",
    codexAuthPath: "D:\\private\\auth.json",
    resourcesAgentsPath: "D:\\source\\resources\\AGENTS.md",
    guildsRoot: "C:\\bot\\guilds",
  }),
}));
vi.mock("../src/tools/mxc-native.js", () => ({ mxcAssetPath: () => "C:\\trusted\\wxc-host-prep.exe" }));

import { prepareWindowsSandbox } from "../src/scripts/prepare-windows-sandbox.js";

const nodeRoot = "C:\\Program Files\\nodejs";
const pythonRoot = "D:\\Tools\\Python";

beforeEach(() => {
  vi.clearAllMocks();
  host.aliases.clear();
  host.dangling.clear();
  host.existing = new Set([
    nodeRoot,
    pythonRoot,
    "C:\\bot",
    "C:\\Windows",
    "C:\\Windows\\System32",
    "D:\\private",
    "D:\\source\\resources\\AGENTS.md",
  ]);
  host.config = { sandbox: { windows: { readonlyPaths: [pythonRoot, "C:\\Windows\\System32"] } } };
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  vi.spyOn(process, "execPath", "get").mockReturnValue(win32.join(nodeRoot, "node.exe"));
  vi.stubEnv("SystemRoot", "C:\\Windows");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("Windows administrator preparation", () => {
  it("grants only restricted-package read/execute to approved tools and leaves Windows system ACLs alone", async () => {
    await prepareWindowsSandbox(host.run);
    expect(host.run).toHaveBeenCalledWith("C:\\trusted\\wxc-host-prep.exe", ["prepare-system-drive"]);
    expect(host.run).toHaveBeenCalledWith("C:\\trusted\\wxc-host-prep.exe", ["prepare-null-device"]);
    const grants = host.run.mock.calls.filter(([command]) => command.endsWith("icacls.exe"));
    expect(new Set(grants.map(([, args]) => args[0]))).toEqual(new Set([nodeRoot, pythonRoot]));
    for (const [, args] of grants) {
      expect(args.slice(1)).toEqual(["/grant", "*S-1-15-2-2:(OI)(CI)(RX)"]);
    }
  });

  it("protects an external auth file before it exists, including aliased ancestors", async () => {
    host.aliases.set("D:\\private", nodeRoot);
    await expect(prepareWindowsSandbox(host.run)).rejects.toThrow("protected");
    expect(host.run).not.toHaveBeenCalled();
  });

  it("rejects a tool alias exposing injected instructions before changing any ACL", async () => {
    host.aliases.set("D:\\source\\resources\\AGENTS.md", win32.join(pythonRoot, "AGENTS.md"));
    await expect(prepareWindowsSandbox(host.run)).rejects.toThrow("protected");
    expect(host.run).not.toHaveBeenCalled();
  });

  it("rejects a dangling auth link before granting persistent read access", async () => {
    host.dangling.add("D:\\private\\auth.json");
    await expect(prepareWindowsSandbox(host.run)).rejects.toThrow("unresolved symbolic link");
    expect(host.run).not.toHaveBeenCalled();
  });

  it("rejects drive-wide grants", async () => {
    host.config = { sandbox: { windows: { readonlyPaths: ["D:\\"] } } };
    await expect(prepareWindowsSandbox(host.run)).rejects.toThrow("entire drive");
    expect(host.run).not.toHaveBeenCalled();
  });

  it("does not grant tool access if native host preparation fails", async () => {
    host.run.mockRejectedValueOnce(new Error("host preparation failed"));
    await expect(prepareWindowsSandbox(host.run)).rejects.toThrow("host preparation failed");
    expect(host.run.mock.calls.some(([command]) => command.endsWith("icacls.exe"))).toBe(false);
  });
});
