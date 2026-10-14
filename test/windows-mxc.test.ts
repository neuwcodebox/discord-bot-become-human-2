import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MxcExecution, MxcProbe, MxcRuntime } from "../src/tools/mxc-native.js";
import { executeWindowsMxcRequest } from "../src/tools/windows-mxc.js";
import { createWindowsMxcRequest } from "../src/tools/windows-mxc-policy.js";

vi.mock("../src/tools/mxc-native.js", () => ({ loadMxcRuntime: vi.fn() }));

const request = createWindowsMxcRequest({
  containerId: "dbh2-abcd",
  workspaceRoot: "C:\\workspace",
  argv: ["C:\\tools\\node.exe"],
  readonlyPaths: ["C:\\tools"],
  deniedPaths: [],
  systemRoot: "C:\\Windows",
  localAppData: "C:\\Users\\Alice\\AppData\\Local",
  timeoutMs: 5000,
  network: true,
});

function fakeRuntime() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child: MxcExecution = {
    stdout,
    stderr,
    poll: vi.fn(() => ({ running: false, exitCode: 0, timedOut: false })),
    kill: vi.fn(),
    close: vi.fn(async () => {
      stdout.end();
      stderr.end();
    }),
  };
  const runtime: MxcRuntime = {
    probe: vi.fn((): MxcProbe => ({ tier: "appcontainer-dacl", warnings: [] })),
    spawn: vi.fn(async () => child),
  };
  return { runtime, child, stdout, stderr };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("Windows sandbox execution contract", () => {
  it("returns independently capped stdout and stderr after resource cleanup", async () => {
    const { runtime, child, stdout, stderr } = fakeRuntime();
    stdout.write(Buffer.from("abcdef"));
    stderr.write(Buffer.from("123456"));
    expect(await executeWindowsMxcRequest(request, 3, undefined, runtime)).toMatchObject({
      exitCode: 0,
      stdout: "abc",
      stderr: "123",
      stdoutTruncated: true,
      stderrTruncated: true,
      timedOut: false,
    });
    expect(child.close).toHaveBeenCalledOnce();
  });

  it.each(["base-container", "appcontainer-bfs"] as const)(
    "refuses unsupported isolation tier %s",
    async (tier) => {
      const { runtime } = fakeRuntime();
      vi.mocked(runtime.probe).mockReturnValue({ tier, warnings: [] });
      await expect(executeWindowsMxcRequest(request, 100, undefined, runtime)).rejects.toThrow("LPAC");
      expect(runtime.spawn).not.toHaveBeenCalled();
    },
  );

  it("requires administrator host preparation before launching", async () => {
    const { runtime } = fakeRuntime();
    vi.mocked(runtime.probe).mockReturnValue({
      tier: "appcontainer-dacl",
      warnings: ["Run wxc-host-prep prepare-null-device"],
    });
    await expect(executeWindowsMxcRequest(request, 100, undefined, runtime)).rejects.toThrow(
      "sandbox:prepare",
    );
    expect(runtime.spawn).not.toHaveBeenCalled();
  });

  it("reports rejected policy without launching", async () => {
    const { runtime } = fakeRuntime();
    vi.mocked(runtime.probe).mockReturnValue({ warnings: [], error: "WRITE_DAC unavailable" });
    await expect(executeWindowsMxcRequest(request, 100, undefined, runtime)).rejects.toThrow(
      "filesystem policy",
    );
    expect(runtime.spawn).not.toHaveBeenCalled();
  });

  it("does not launch a pre-cancelled request", async () => {
    const { runtime } = fakeRuntime();
    const controller = new AbortController();
    controller.abort();
    await expect(executeWindowsMxcRequest(request, 100, controller.signal, runtime)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(runtime.spawn).not.toHaveBeenCalled();
  });

  it("waits for cleanup when cancellation arrives during native launch", async () => {
    const { runtime, child, stdout, stderr } = fakeRuntime();
    const spawn = Promise.withResolvers<MxcExecution>();
    const cleanupStarted = Promise.withResolvers<void>();
    const cleanupFinished = Promise.withResolvers<void>();
    vi.mocked(runtime.spawn).mockReturnValue(spawn.promise);
    vi.mocked(child.close).mockImplementation(async () => {
      cleanupStarted.resolve();
      await cleanupFinished.promise;
      stdout.end();
      stderr.end();
    });
    const controller = new AbortController();
    const running = executeWindowsMxcRequest(request, 100, controller.signal, runtime);
    const rejected = expect(running).rejects.toMatchObject({ name: "AbortError" });
    let settled = false;
    void running.catch(() => {
      settled = true;
    });
    controller.abort();
    spawn.resolve(child);
    await cleanupStarted.promise;
    expect(child.kill).toHaveBeenCalledWith(false);
    expect(settled).toBe(false);
    cleanupFinished.resolve();
    await rejected;
    expect(child.close).toHaveBeenCalledOnce();
  });

  it("terminates timed-out commands and cleans up before returning", async () => {
    const { runtime, child } = fakeRuntime();
    vi.mocked(child.poll).mockReturnValue({ running: true, exitCode: 0, timedOut: false });
    vi.mocked(child.kill).mockImplementation(() => {
      vi.mocked(child.poll).mockReturnValue({ running: false, exitCode: -1, timedOut: true });
    });
    const running = executeWindowsMxcRequest(
      { ...request, process: { ...request.process, timeout: 50 } },
      100,
      undefined,
      runtime,
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(await running).toMatchObject({ timedOut: true, exitCode: -1 });
    expect(child.kill).toHaveBeenCalledWith(true);
    expect(child.close).toHaveBeenCalledOnce();
  });

  it("cleans up when an output pipe fails", async () => {
    const { runtime, child, stdout } = fakeRuntime();
    vi.mocked(child.poll).mockReturnValue({ running: true, exitCode: 0, timedOut: false });
    const running = executeWindowsMxcRequest(request, 100, undefined, runtime);
    const rejected = expect(running).rejects.toThrow("pipe failed");
    stdout.destroy(new Error("pipe failed"));
    await vi.advanceTimersByTimeAsync(25);
    await rejected;
    expect(child.close).toHaveBeenCalledOnce();
  });
});
