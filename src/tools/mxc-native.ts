import { createReadStream } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import koffi from "koffi";
import { z } from "zod";

export const mxcProbeSchema = z.object({
  tier: z.enum(["base-container", "appcontainer-bfs", "appcontainer-dacl"]).optional(),
  warnings: z.array(z.string()),
  error: z.string().optional(),
});
export type MxcProbe = z.infer<typeof mxcProbeSchema>;

const statusSchema = z.number().int();
const pointerSchema = z
  .unknown()
  .refine(
    (value) => value !== null && value !== undefined && value !== 0 && value !== 0n,
    "MXC returned a null handle.",
  );
const nativeStdioSchema = z.object({
  stdin_handle: z.union([z.number().int(), z.bigint()]),
  stdout_handle: z.union([z.number().int(), z.bigint()]),
  stderr_handle: z.union([z.number().int(), z.bigint()]),
});

export type MxcExecution = {
  stdout: Readable | null;
  stderr: Readable | null;
  poll(): { running: boolean; exitCode: number; timedOut: boolean };
  kill(timedOut: boolean): void;
  close(): Promise<void>;
};

export type MxcRuntime = {
  probe(requestJson: string): MxcProbe;
  spawn(requestJson: string): Promise<MxcExecution>;
};

export function mxcAssetPath(file: string): string {
  if (process.arch !== "x64" && process.arch !== "arm64") {
    throw new Error("Windows MXC requires x64 or ARM64.");
  }
  const require = createRequire(import.meta.url);
  try {
    const packageRoot = dirname(require.resolve("@microsoft/mxc-sdk/package.json"));
    return join(packageRoot, "bin", process.arch, file);
  } catch (cause) {
    throw new Error(
      "MXC runtime is missing. Install optional dependencies with npm install --include=optional.",
      {
        cause,
      },
    );
  }
}

export function assertMxcNodeVersion(version: string): void {
  const parts = version.split(".").map(Number);
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  if ((major === 24 && minor >= 21) || (major === 26 && minor >= 8) || major >= 27) return;
  throw new Error("Windows sandbox requires Node.js 24.21+ (24.x) or 26.8+ for native Windows pipe handles.");
}

let runtime: MxcRuntime | undefined;

/**
 * Bind MXC 1.0.0's JSON C ABI, rather than private Node SDK modules. The public
 * Node request adapter rejects LPAC and forces leastPrivilege=false. Pin the
 * runtime package and keep every owned native handle behind this boundary.
 */
export function loadMxcRuntime(): MxcRuntime {
  if (process.platform !== "win32") throw new Error("MXC Windows execution requires Windows.");
  assertMxcNodeVersion(process.versions.node);
  runtime ??= bindMxcRuntime(mxcAssetPath("mxc_ffi.dll"));
  return runtime;
}

/** Owns the handles transferred through MXC's native ABI. */
export function bindMxcRuntime(libraryPath: string): MxcRuntime {
  const library = koffi.load(libraryPath);
  const sandboxType = koffi.opaque("Dbh2MxcSandbox");
  const sandboxPointer = koffi.pointer(sandboxType);
  const errorType = koffi.struct("Dbh2MxcError", {
    message: "void *",
    operation: "void *",
    nativeCode: "void *",
    remediation: "void *",
  });
  const stdioType = koffi.struct("Dbh2MxcStdio", {
    stdin_handle: "intptr_t",
    stdout_handle: "intptr_t",
    stderr_handle: "intptr_t",
  });
  const probe = library.func("mxc_probe_request_json_with_error", "int32_t", [
    "const char *",
    koffi.out(koffi.pointer("void *")),
    koffi.out(koffi.pointer(errorType)),
  ]);
  const spawn = library.func("mxc_spawn_json", "int32_t", [
    "const char *",
    "int32_t",
    koffi.out(koffi.pointer(sandboxType, 2)),
    koffi.out(koffi.pointer(errorType)),
  ]);
  const takeStdio = library.func("mxc_sandbox_take_native_stdio", "int32_t", [
    sandboxPointer,
    koffi.out(koffi.pointer(stdioType)),
  ]);
  const poll = library.func("mxc_sandbox_try_wait", "int32_t", [
    sandboxPointer,
    koffi.out(koffi.pointer("int32_t")),
    koffi.out(koffi.pointer("int32_t")),
    koffi.out(koffi.pointer("int32_t")),
  ]);
  const kill = library.func("mxc_sandbox_kill", "int32_t", [sandboxPointer]);
  const killForTimeout = library.func("mxc_sandbox_kill_for_timeout", "int32_t", [sandboxPointer]);
  const free = library.func("mxc_sandbox_free", "void", [sandboxPointer]);
  const closePipe = library.func("mxc_native_pipe_close", "void", ["intptr_t"]);
  const freeString = library.func("mxc_string_free", "void", ["void *"]);
  const freeError = library.func("mxc_error_detail_free", "void", [koffi.pointer(errorType)]);

  function checkedStatus(value: unknown, operation: string, detail?: Record<string, unknown>): void {
    const status = statusSchema.parse(value);
    if (status === 0) return;
    const messagePointer = detail?.message;
    let message = `MXC ${operation} failed (status ${status}).`;
    if (
      messagePointer !== undefined &&
      messagePointer !== null &&
      messagePointer !== 0 &&
      messagePointer !== 0n
    ) {
      message = z.string().parse(koffi.decode(messagePointer, "char", -1));
    }
    throw new Error(message);
  }

  function freeHandle(handle: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
      free.async(handle, (error: unknown) => (error == null ? resolve() : reject(error)));
    });
  }

  return {
    probe(requestJson) {
      const output: unknown[] = [null];
      const detail: Record<string, unknown> = {};
      try {
        checkedStatus(probe(requestJson, output, detail), "probe", detail);
        const pointer = pointerSchema.parse(output[0]);
        try {
          const json = z.string().parse(koffi.decode(pointer, "char", -1));
          return mxcProbeSchema.parse(JSON.parse(json));
        } finally {
          freeString(pointer);
        }
      } finally {
        freeError(detail);
      }
    },
    async spawn(requestJson) {
      const output: unknown[] = [null];
      const detail: Record<string, unknown> = {};
      try {
        const status = await new Promise<unknown>((resolve, reject) => {
          spawn.async(requestJson, 0, output, detail, (error: unknown, value: unknown) =>
            error == null ? resolve(value) : reject(error),
          );
        });
        checkedStatus(status, "spawn", detail);
      } finally {
        freeError(detail);
      }
      const handle = pointerSchema.parse(output[0]);
      const stdioOutput: Record<string, unknown> = {};
      const adopted: Readable[] = [];
      const unowned: Array<number | bigint> = [];
      try {
        checkedStatus(takeStdio(handle, stdioOutput), "stdio transfer");
        const stdio = nativeStdioSchema.parse(stdioOutput);
        // This tool never accepts stdin. Close the transferred input endpoint.
        closePipe(stdio.stdin_handle);
        unowned.push(stdio.stdout_handle, stdio.stderr_handle);
        function adopt(raw: number | bigint): Readable | null {
          if (raw === 0 || raw === 0n) {
            unowned.shift();
            return null;
          }
          // windowsHandle is supported by the runtime versions checked above.
          // A named options object also works with older @types/node releases.
          const options = { autoClose: true, windowsHandle: BigInt(raw) };
          const stream = createReadStream("", options);
          adopted.push(stream);
          unowned.shift();
          return stream;
        }
        const stdout = adopt(stdio.stdout_handle);
        const stderr = adopt(stdio.stderr_handle);
        let closing: Promise<void> | undefined;
        return {
          stdout,
          stderr,
          poll() {
            if (closing) throw new Error("MXC handle is already closing.");
            const exit = [0];
            const running = [0];
            const timedOut = [0];
            checkedStatus(poll(handle, exit, running, timedOut), "poll");
            return {
              running: statusSchema.parse(running[0]) !== 0,
              exitCode: statusSchema.parse(exit[0]),
              timedOut: statusSchema.parse(timedOut[0]) !== 0,
            };
          },
          kill(timedOut) {
            if (closing) return;
            checkedStatus(timedOut ? killForTimeout(handle) : kill(handle), "termination");
          },
          close() {
            // No native sandbox calls may overlap. Async free begins only after
            // polling and cancellation have stopped, and is awaited for ACL cleanup.
            closing ??= freeHandle(handle);
            return closing;
          },
        };
      } catch (error) {
        for (const stream of adopted) stream.destroy();
        for (const raw of unowned) closePipe(raw);
        await freeHandle(handle);
        throw error;
      }
    },
  };
}
