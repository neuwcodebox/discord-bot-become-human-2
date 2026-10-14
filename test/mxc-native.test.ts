import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  call: vi.fn<(name: string, args: unknown[]) => unknown>(),
  readStream: vi.fn<() => PassThrough>(),
  decode: vi.fn<(pointer: unknown) => unknown>(),
}));

vi.mock("koffi", () => ({
  default: {
    load: () => ({
      func: (name: string) => {
        const fn = (...args: unknown[]) => fake.call(name, args);
        fn.async = (...args: unknown[]) => {
          const callback = args.pop();
          if (typeof callback !== "function") throw new Error("Expected native callback.");
          try {
            callback(null, fake.call(name, args));
          } catch (error) {
            callback(error);
          }
        };
        return fn;
      },
    }),
    opaque: () => ({}),
    pointer: () => ({}),
    out: () => ({}),
    struct: () => ({}),
    decode: (pointer: unknown) => fake.decode(pointer),
  },
}));
vi.mock("node:fs", () => ({ createReadStream: () => fake.readStream() }));

import { assertMxcNodeVersion, bindMxcRuntime } from "../src/tools/mxc-native.js";

function outputArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Expected native output array.");
  return value;
}
function outputRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected native struct.");
  return Object.fromEntries(Object.entries(value));
}

beforeEach(() => {
  vi.clearAllMocks();
  fake.readStream.mockImplementation(() => new PassThrough());
  fake.decode.mockReturnValue('{"tier":"appcontainer-dacl","warnings":[]}');
  fake.call.mockImplementation((name, args) => {
    if (name === "mxc_probe_request_json_with_error") outputArray(args[1])[0] = 123n;
    if (name === "mxc_spawn_json") outputArray(args[2])[0] = 456n;
    if (name === "mxc_sandbox_take_native_stdio") {
      const output = args[1];
      if (output !== null && typeof output === "object")
        Object.assign(output, { stdin_handle: 11n, stdout_handle: 12n, stderr_handle: 13n });
    }
    if (name === "mxc_sandbox_try_wait") {
      outputArray(args[1])[0] = 0;
      outputArray(args[2])[0] = 1;
      outputArray(args[3])[0] = 0;
    }
    return 0;
  });
});

describe("MXC native ABI ownership", () => {
  it.each(["24.21.0", "24.22.1", "26.8.0", "27.0.0"])(
    "supports native pipe transfer on Node %s",
    (version) => {
      expect(() => assertMxcNodeVersion(version)).not.toThrow();
    },
  );
  it.each(["24.11.1", "24.20.9", "25.0.0", "26.7.9"])(
    "rejects Node %s without native pipe support",
    (version) => {
      expect(() => assertMxcNodeVersion(version)).toThrow("24.21");
    },
  );
  it("validates probe JSON and releases its native string even when parsing fails", () => {
    const runtime = bindMxcRuntime("fixture.dll");
    fake.decode.mockReturnValue("malformed");
    expect(() => runtime.probe("{}")).toThrow();
    expect(fake.call).toHaveBeenCalledWith("mxc_string_free", [123n]);
    expect(fake.call).toHaveBeenCalledWith("mxc_error_detail_free", [expect.any(Object)]);
  });

  it("closes stdin, transfers output ownership, and frees a sandbox exactly once", async () => {
    const runtime = bindMxcRuntime("fixture.dll");
    const child = await runtime.spawn('{"processContainer":{"leastPrivilege":true}}');
    expect(fake.call).toHaveBeenCalledWith("mxc_spawn_json", [
      '{"processContainer":{"leastPrivilege":true}}',
      0,
      expect.any(Array),
      expect.any(Object),
    ]);
    expect(fake.call).toHaveBeenCalledWith("mxc_native_pipe_close", [11n]);
    expect(child.poll().running).toBe(true);
    child.kill(false);
    await child.close();
    await child.close();
    expect(fake.call.mock.calls.filter(([name]) => name === "mxc_sandbox_free")).toHaveLength(1);
    expect(() => child.poll()).toThrow("closing");
    expect(fake.call.mock.calls.filter(([name]) => name === "mxc_native_pipe_close")).toHaveLength(1);
    child.stdout?.destroy();
    child.stderr?.destroy();
  });

  it("rolls back transferred pipes and the native sandbox if stream adoption fails", async () => {
    const runtime = bindMxcRuntime("fixture.dll");
    const firstStream = new PassThrough();
    fake.readStream.mockReturnValueOnce(firstStream).mockImplementationOnce(() => {
      throw new Error("adoption failed");
    });
    await expect(runtime.spawn("{}")).rejects.toThrow("adoption failed");
    expect(firstStream.destroyed).toBe(true);
    expect(fake.call).toHaveBeenCalledWith("mxc_native_pipe_close", [13n]);
    expect(fake.call.mock.calls.filter(([name]) => name === "mxc_sandbox_free")).toHaveLength(1);
  });

  it("releases native error details on spawn rejection without freeing a nonexistent sandbox", async () => {
    const runtime = bindMxcRuntime("fixture.dll");
    fake.call.mockImplementation((name, args) => {
      if (name === "mxc_spawn_json") {
        const detail = args[3];
        outputRecord(detail);
        if (detail !== null && typeof detail === "object") Object.assign(detail, { message: 999n });
        return 11;
      }
      return 0;
    });
    fake.decode.mockReturnValue("LPAC policy rejected");
    await expect(runtime.spawn("{}")).rejects.toThrow("LPAC policy rejected");
    expect(fake.call).toHaveBeenCalledWith("mxc_error_detail_free", [
      expect.objectContaining({ message: 999n }),
    ]);
    expect(fake.call.mock.calls.some(([name]) => name === "mxc_sandbox_free")).toBe(false);
  });

  it("frees the sandbox when native stdio transfer fails", async () => {
    const runtime = bindMxcRuntime("fixture.dll");
    const normal = fake.call.getMockImplementation();
    fake.call.mockImplementation((name, args) =>
      name === "mxc_sandbox_take_native_stdio" ? 12 : normal?.(name, args),
    );
    await expect(runtime.spawn("{}")).rejects.toThrow("stdio transfer");
    expect(fake.call).toHaveBeenCalledWith("mxc_sandbox_free", [456n]);
  });
});
