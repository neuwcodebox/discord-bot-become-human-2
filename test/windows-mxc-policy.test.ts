import { describe, expect, it } from "vitest";
import {
  assertWindowsReadonlyPaths,
  createWindowsMxcRequest,
  isWindowsPathInside,
  windowsCommandLine,
} from "../src/tools/windows-mxc-policy.js";

const workspaceRoot = "C:\\bot\\guilds\\123\\workspace";
const input = {
  containerId: "dbh2-01234567-89ab-cdef",
  workspaceRoot,
  argv: ["C:\\Program Files\\nodejs\\node.exe", "-e", 'console.log("hello")'],
  readonlyPaths: ["C:\\Program Files\\nodejs", "C:\\Windows\\System32"],
  deniedPaths: ["C:\\bot\\config.json", "C:\\bot\\codex-auth.json"],
  systemRoot: "C:\\Windows",
  localAppData: "C:\\Users\\Alice\\AppData\\Local",
  timeoutMs: 30000,
  network: true,
};

describe("Windows sandbox policy", () => {
  it("enforces LPAC, a single writable workspace, no inherited env, and ACL cleanup", () => {
    const request = createWindowsMxcRequest(input);
    expect(request.processContainer.leastPrivilege).toBe(true);
    expect(request.processContainer.capabilities).toEqual([]);
    expect(request.filesystem.readwritePaths).toEqual([workspaceRoot]);
    expect(request.filesystem.deniedPaths).toEqual(input.deniedPaths);
    expect(request.lifecycle).toEqual({ destroyOnExit: true, preservePolicy: false });
    expect(request.process.inheritDefaultEnv).toBe(false);
    expect(request.process.env).toContain(`TEMP=${workspaceRoot}\\.sandbox\\tmp`);
    expect(request.process.env).toContain(`HOME=${workspaceRoot}`);
    expect(request.process.env.some((entry) => entry.startsWith("DISCORD_BOT_TOKEN="))).toBe(false);
    expect(request.telemetry.enabled).toBe(false);
  });

  it("can allow Internet and private network access without widening file grants", () => {
    const open = createWindowsMxcRequest(input);
    const closed = createWindowsMxcRequest({ ...input, network: false });
    expect(open.network.egress.default).toBe("allow");
    expect(open.network.ingress.default).toBe("allow");
    expect(closed.network.egress.default).toBe("deny");
    expect(closed.network.ingress.default).toBe("deny");
    expect(open.filesystem).toEqual(closed.filesystem);
  });

  it.each(["C:\\", "C:\\bot", "C:\\bot\\guilds", "C:\\bot\\guilds\\123", "C:\\bot\\config.json"])(
    "rejects unsafe read-only grant %s",
    (readonlyPath) => {
      expect(() =>
        assertWindowsReadonlyPaths({
          workspaceRoot,
          readonlyPaths: [readonlyPath],
          protectedPaths: ["C:\\bot\\config.json"],
        }),
      ).toThrow();
    },
  );

  it("rejects directories containing injected instructions or external auth", () => {
    expect(() =>
      assertWindowsReadonlyPaths({
        workspaceRoot,
        readonlyPaths: ["D:\\source"],
        protectedPaths: ["D:\\source\\resources\\AGENTS.md"],
      }),
    ).toThrow("protected");
    expect(() =>
      assertWindowsReadonlyPaths({
        workspaceRoot,
        readonlyPaths: ["D:\\private"],
        protectedPaths: ["D:\\private\\codex-auth.json"],
      }),
    ).toThrow("protected");
  });

  it("accepts individual approved tool directories", () => {
    expect(() =>
      assertWindowsReadonlyPaths({
        workspaceRoot,
        readonlyPaths: input.readonlyPaths,
        protectedPaths: input.deniedPaths,
      }),
    ).not.toThrow();
  });

  it("checks Windows paths case-insensitively and rejects sibling prefixes", () => {
    expect(isWindowsPathInside(workspaceRoot, "c:\\BOT\\guilds\\123\\workspace\\file.txt")).toBe(true);
    expect(isWindowsPathInside(workspaceRoot, "C:\\bot\\guilds\\123\\workspace-other\\file.txt")).toBe(false);
    expect(isWindowsPathInside(workspaceRoot, "C:\\bot\\guilds\\456\\workspace\\file.txt")).toBe(false);
    expect(isWindowsPathInside(workspaceRoot, "D:\\file.txt")).toBe(false);
  });

  it.each(["\\\\server\\share\\tool", "C:relative", "C:\\file:stream", "C:\\file\0name"])(
    "rejects non-local or ambiguous path %s",
    (readonlyPath) => {
      expect(() =>
        assertWindowsReadonlyPaths({ workspaceRoot, readonlyPaths: [readonlyPath], protectedPaths: [] }),
      ).toThrow();
    },
  );

  it("quotes empty arguments, embedded quotes, and trailing backslashes", () => {
    expect(windowsCommandLine(["node.exe", "", "a b", 'a"b', "C:\\a\\"])).toBe(
      '"node.exe" "" "a b" "a\\"b" "C:\\a\\\\"',
    );
    expect(windowsCommandLine(["node.exe", 'a\\"b', "&|%NAME%$()"])).toBe(
      '"node.exe" "a\\\\\\"b" "&|%NAME%$()"',
    );
  });

  it("rejects NUL and oversized command lines", () => {
    expect(() => windowsCommandLine(["node.exe", "\0"])).toThrow("NUL");
    expect(() => windowsCommandLine(["node.exe", "x".repeat(32766)])).toThrow("32766");
  });
});
