import { win32 } from "node:path";
import { z } from "zod";

const windowsPath = z
  .string()
  .min(1)
  .refine(
    (value) => /^[a-z]:\\/i.test(value) && !value.includes("\0") && !value.slice(2).includes(":"),
    "A local absolute Windows drive path is required.",
  );

// Narrow subset of MXC's published 1.0.0 JSON contract. LPAC is deliberately
// mandatory; the high-level Node SDK currently forces leastPrivilege=false.
export const windowsMxcRequestSchema = z.object({
  version: z.literal("1.0.0"),
  containerId: z.string().regex(/^dbh2-[a-f0-9-]+$/),
  containment: z.literal("processcontainer"),
  lifecycle: z.object({ destroyOnExit: z.literal(true), preservePolicy: z.literal(false) }),
  fallback: z.object({ allowDaclMutation: z.literal(true) }),
  process: z.object({
    commandLine: z.string().min(1).max(32766),
    cwd: windowsPath,
    env: z.array(z.string()),
    inheritDefaultEnv: z.literal(false),
    timeout: z.number().int().positive(),
  }),
  filesystem: z.object({
    readwritePaths: z.array(windowsPath).length(1),
    readonlyPaths: z.array(windowsPath),
    deniedPaths: z.array(windowsPath),
  }),
  network: z.object({
    egress: z.object({ default: z.enum(["allow", "deny"]) }),
    ingress: z.object({ default: z.enum(["allow", "deny"]), hostLoopback: z.literal("deny") }),
  }),
  ui: z.object({ disable: z.literal(true), clipboard: z.literal("none"), injection: z.literal(false) }),
  processContainer: z.object({
    leastPrivilege: z.literal(true),
    capabilities: z.array(z.string()).length(0),
  }),
  telemetry: z.object({ enabled: z.literal(false) }),
});

export type WindowsMxcRequest = z.infer<typeof windowsMxcRequestSchema>;

export function isWindowsPathInside(root: string, target: string): boolean {
  const relative = win32.relative(root, target);
  return (
    relative === "" || (!relative.startsWith("..\\") && relative !== ".." && !win32.isAbsolute(relative))
  );
}

export function assertWindowsReadonlyPaths(input: {
  workspaceRoot: string;
  readonlyPaths: string[];
  protectedPaths: string[];
}): void {
  for (const candidate of input.readonlyPaths) {
    windowsPath.parse(candidate);
    if (win32.parse(candidate).root.toLowerCase() === win32.resolve(candidate).toLowerCase()) {
      throw new Error("Windows sandbox cannot grant an entire drive.");
    }
    // An operator may grant individual tool directories, never a parent of a
    // workspace or a directory exposing config, auth, or injected instructions.
    if (
      isWindowsPathInside(candidate, input.workspaceRoot) &&
      !isWindowsPathInside(input.workspaceRoot, candidate)
    ) {
      throw new Error("Windows sandbox readonly paths cannot include workspace ancestors.");
    }
    if (
      input.protectedPaths.some(
        (protectedPath) =>
          isWindowsPathInside(candidate, protectedPath) || isWindowsPathInside(protectedPath, candidate),
      )
    ) {
      throw new Error("Windows sandbox readonly paths overlap protected runtime files.");
    }
  }
}

/** Windows CRT quoting, for CreateProcessW directly; no implicit cmd.exe. */
export function windowsCommandLine(argv: readonly string[]): string {
  if (argv.length === 0 || !argv[0]) throw new Error("argv must not be empty.");
  if (argv.some((argument) => argument.includes("\0"))) throw new Error("argv cannot contain NUL.");
  const commandLine = argv
    .map((argument) => `"${argument.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1")}"`)
    .join(" ");
  if (commandLine.length > 32766) throw new Error("Windows command line exceeds 32766 characters.");
  return commandLine;
}

export function createWindowsMxcRequest(input: {
  containerId: string;
  workspaceRoot: string;
  argv: string[];
  readonlyPaths: string[];
  deniedPaths: string[];
  systemRoot: string;
  localAppData: string;
  timeoutMs: number;
  network: boolean;
}): WindowsMxcRequest {
  const temporaryRoot = win32.join(input.workspaceRoot, ".sandbox", "tmp");
  // Use an allowlist: neither process.env nor the user's profile environment is
  // inherited. All tool caches and temporary files point inside the workspace.
  const environment = {
    SYSTEMROOT: input.systemRoot,
    WINDIR: input.systemRoot,
    LOCALAPPDATA: input.localAppData,
    USERPROFILE: input.workspaceRoot,
    HOME: input.workspaceRoot,
    APPDATA: win32.join(input.workspaceRoot, ".sandbox", "appdata"),
    TEMP: temporaryRoot,
    TMP: temporaryRoot,
    PATH: input.readonlyPaths.join(";"),
    PATHEXT: ".EXE",
  };
  return windowsMxcRequestSchema.parse({
    version: "1.0.0",
    containerId: input.containerId,
    containment: "processcontainer",
    lifecycle: { destroyOnExit: true, preservePolicy: false },
    fallback: { allowDaclMutation: true },
    process: {
      commandLine: windowsCommandLine(input.argv),
      cwd: input.workspaceRoot,
      env: Object.entries(environment).map(([key, value]) => `${key}=${value}`),
      inheritDefaultEnv: false,
      timeout: input.timeoutMs,
    },
    filesystem: {
      readwritePaths: [input.workspaceRoot],
      readonlyPaths: input.readonlyPaths,
      deniedPaths: input.deniedPaths,
    },
    network: {
      egress: { default: input.network ? "allow" : "deny" },
      ingress: { default: input.network ? "allow" : "deny", hostLoopback: "deny" },
    },
    ui: { disable: true, clipboard: "none", injection: false },
    processContainer: { leastPrivilege: true, capabilities: [] },
    telemetry: { enabled: false },
  });
}
