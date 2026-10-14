import { randomUUID } from "node:crypto";
import { mkdir, readdir, realpath, stat } from "node:fs/promises";
import { win32 } from "node:path";
import { existingCanonicalPath } from "../paths/canonical-path.js";
import { expandHome } from "../paths/runtime-paths.js";
import { assertInsideWorkspace } from "../paths/workspace-guard.js";
import type { AppConfig, ToolContext } from "../types.js";
import { resolveWindowsReadonlyPaths } from "./windows-mxc-paths.js";
import {
  createWindowsMxcRequest,
  isWindowsPathInside,
  type WindowsMxcRequest,
  windowsCommandLine,
} from "./windows-mxc-policy.js";

async function resolveExecutable(
  argv0: string,
  workspaceRoot: string,
  readonlyPaths: string[],
): Promise<string> {
  const approvedRoots = [workspaceRoot, ...readonlyPaths];
  const assertApproved = (target: string) => {
    if (!approvedRoots.some((root) => isWindowsPathInside(root, target))) {
      throw new Error("Windows sandbox executable is outside the approved runtime paths.");
    }
  };
  const hasPath = /[\\/:]/.test(argv0);
  const candidates = hasPath
    ? [win32.isAbsolute(argv0) ? argv0 : win32.resolve(workspaceRoot, argv0)]
    : [workspaceRoot, ...readonlyPaths].map((directory) =>
        win32.join(directory, /\.exe$/i.test(argv0) ? argv0 : `${argv0}.exe`),
      );
  for (const candidate of candidates) {
    assertApproved(candidate);
    const resolved = await existingCanonicalPath(candidate);
    if (!resolved) continue;
    if (!/\.exe$/i.test(resolved))
      throw new Error(
        "Windows sandbox requires an executable (.exe); invoke script interpreters explicitly.",
      );
    assertApproved(resolved);
    if (!(await stat(resolved)).isFile())
      throw new Error("Windows sandbox command is not an executable file.");
    return resolved;
  }
  throw new Error("Windows sandbox executable was not found in the workspace or approved runtime paths.");
}

export async function prepareWindowsMxcRequest(
  context: ToolContext,
  config: AppConfig,
  argv: string[],
): Promise<WindowsMxcRequest> {
  windowsCommandLine(argv);
  const command = argv[0];
  if (!command) throw new Error("argv must not be empty.");
  if (/^[a-z]:[^\\]/i.test(command) || command.startsWith("\\\\")) {
    throw new Error("Windows sandbox requires local, unambiguous executable paths.");
  }
  const workspaceRoot = await realpath(context.workspaceRoot);
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  const localAppData = process.env.LOCALAPPDATA;
  if (!systemRoot || !localAppData) throw new Error("Windows sandbox requires SYSTEMROOT and LOCALAPPDATA.");
  const runtimeRoot = win32.resolve(expandHome(config.runtime.rootDir));
  if (
    !context.guildId ||
    /[\\/:\0]/.test(context.guildId) ||
    context.guildId === "." ||
    context.guildId === ".."
  ) {
    throw new Error("Windows sandbox requires an unambiguous guild ID.");
  }
  const guildsRoot = win32.join(runtimeRoot, "guilds");
  const guildRoot = win32.join(guildsRoot, context.guildId);
  const expectedWorkspace = await realpath(win32.join(guildRoot, "workspace"));
  if (win32.relative(expectedWorkspace, workspaceRoot) !== "") {
    throw new Error("Windows sandbox workspace does not match the current guild.");
  }
  const authPath =
    config.llm.provider === "openai-codex" ? win32.resolve(expandHome(config.llm.codex.authPath)) : undefined;
  const protectedFiles = [
    win32.join(runtimeRoot, "config.json"),
    ...(authPath ? [authPath] : []),
    ...(context.protectedPaths ?? []),
  ];
  const deniedPaths = (await Promise.all(protectedFiles.map(existingCanonicalPath))).filter(
    (value) => value !== undefined,
  );
  // Explicitly subtract access to other guilds and host-side current-guild
  // records, even on hosts that have unusually broad AppContainer ACL grants.
  const isolatedGuildPaths: string[] = [];
  for (const entry of await readdir(guildsRoot)) {
    if (entry.toLowerCase() !== context.guildId.toLowerCase())
      isolatedGuildPaths.push(win32.join(guildsRoot, entry));
  }
  for (const entry of await readdir(guildRoot)) {
    if (entry.toLowerCase() !== "workspace") isolatedGuildPaths.push(win32.join(guildRoot, entry));
  }
  deniedPaths.push(...(await Promise.all(isolatedGuildPaths.map((candidate) => realpath(candidate)))));
  if (deniedPaths.some((protectedPath) => isWindowsPathInside(workspaceRoot, protectedPath))) {
    throw new Error("Windows sandbox workspace contains protected runtime files.");
  }
  const requestedReadonlyPaths = [
    win32.dirname(process.execPath),
    win32.join(systemRoot, "System32"),
    ...config.sandbox.windows.readonlyPaths.map(expandHome),
  ];
  const protectedPaths = [runtimeRoot, ...(authPath ? [authPath] : []), ...protectedFiles, ...deniedPaths];
  const readonlyPaths = await resolveWindowsReadonlyPaths({
    workspaceRoot,
    readonlyPaths: requestedReadonlyPaths,
    protectedPaths,
  });
  const executable = await resolveExecutable(command, workspaceRoot, readonlyPaths);
  // Do not follow a workspace junction into a different guild when creating
  // temporary/cache directories. These paths must pass the same file guard.
  for (const relativePath of [".sandbox/tmp", ".sandbox/appdata"]) {
    const guarded = await assertInsideWorkspace(workspaceRoot, relativePath);
    await mkdir(guarded, { recursive: true });
    await assertInsideWorkspace(workspaceRoot, relativePath);
  }
  return createWindowsMxcRequest({
    containerId: `dbh2-${randomUUID()}`,
    workspaceRoot,
    argv: [executable, ...argv.slice(1)],
    readonlyPaths,
    deniedPaths,
    systemRoot,
    localAppData,
    timeoutMs: config.sandbox.timeoutMs,
    network: config.sandbox.network,
  });
}
