import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { loadOrCreateConfig } from "../config.js";
import { createRuntimePaths, expandHome } from "../paths/runtime-paths.js";
import { mxcAssetPath } from "../tools/mxc-native.js";
import { resolveWindowsReadonlyPaths } from "../tools/windows-mxc-paths.js";
import { isWindowsPathInside } from "../tools/windows-mxc-policy.js";

const run = promisify(execFile);

type PreparationCommand = (command: string, args: string[]) => Promise<void>;

async function runPreparationCommand(command: string, args: string[]): Promise<void> {
  const result = await run(command, args, { timeout: 30_000, windowsHide: true });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
}

export async function prepareWindowsSandbox(
  runCommand: PreparationCommand = runPreparationCommand,
): Promise<void> {
  if (process.platform !== "win32") throw new Error("sandbox:prepare is available only on Windows.");
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!systemRoot) throw new Error("SYSTEMROOT is required.");
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const bootstrap = await loadOrCreateConfig(join(homedir(), ".discord-bot-become-human-2", "config.json"));
  const paths = createRuntimePaths(projectRoot, bootstrap);
  const config = await loadOrCreateConfig(paths.configPath);
  const requestedPaths = [
    win32.dirname(process.execPath),
    ...config.sandbox.windows.readonlyPaths.map(expandHome),
  ];
  const protectedPaths = [
    paths.runtimeRoot,
    await realpath(paths.runtimeRoot),
    paths.resourcesAgentsPath,
    ...(paths.codexAuthPath ? [paths.codexAuthPath] : []),
  ];
  const runtimeDirectories = await resolveWindowsReadonlyPaths({
    workspaceRoot: win32.join(paths.guildsRoot, "__host_preparation__", "workspace"),
    readonlyPaths: requestedPaths,
    protectedPaths,
  });

  // Only this operator command performs administrator-only host setup. The bot
  // never elevates itself. Run from an elevated terminal after boot.
  const helper = mxcAssetPath("wxc-host-prep.exe");
  for (const command of ["prepare-system-drive", "prepare-null-device"]) {
    await runCommand(helper, [command]);
  }
  // LPAC cannot use ordinary ALL APPLICATION PACKAGES grants. Installed tools
  // often live under administrator-owned Program Files, where the bot cannot
  // add per-run ACEs. Grant only read/execute to the restricted-package group at
  // setup time. Windows system directories retain their OS-managed ACLs.
  const canonicalSystemRoot = await realpath(systemRoot);
  const icacls = win32.join(systemRoot, "System32", "icacls.exe");
  for (const directory of runtimeDirectories) {
    if (isWindowsPathInside(canonicalSystemRoot, directory)) continue;
    await runCommand(icacls, [directory, "/grant", "*S-1-15-2-2:(OI)(CI)(RX)"]);
  }
  process.stdout.write(
    "Windows MXC host preparation completed. Run npm run test:sandbox:windows to verify isolation.\n",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  prepareWindowsSandbox().catch(() => {
    process.stderr.write(
      "Windows MXC preparation failed. Run npm run sandbox:prepare from an administrator terminal; ensure optional npm dependencies are installed and approved tool paths do not expose runtime files.\n",
    );
    process.exitCode = 1;
  });
}
