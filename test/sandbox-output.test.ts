import { describe, expect, it } from "vitest";
import { SandboxOutput } from "../src/tools/sandbox-output.js";

describe("sandbox output contract", () => {
  it("preserves UTF-8 regardless of pipe chunk boundaries", () => {
    const bytes = Buffer.from("a가😀z");
    const output = new SandboxOutput(bytes.length);
    for (const byte of bytes) output.append(Buffer.from([byte]));
    output.finish();
    expect(output.text).toBe("a가😀z");
    expect(output.truncated).toBe(false);
  });

  it.each([
    { text: "abcdef", limit: 3, expected: "abc" },
    { text: "가나다", limit: 7, expected: "가나" },
    { text: "😀a", limit: 3, expected: "" },
  ])("caps output at $limit bytes without splitting a character", ({ text, limit, expected }) => {
    const output = new SandboxOutput(limit);
    output.append(Buffer.from(text));
    output.append(Buffer.from("discarded"));
    output.finish();
    expect(output.text).toBe(expected);
    expect(Buffer.byteLength(output.text)).toBeLessThanOrEqual(limit);
    expect(output.truncated).toBe(true);
  });

  it("marks truncation only when output exceeds the limit", () => {
    const output = new SandboxOutput(3);
    output.append(Buffer.from("abc"));
    expect(output.truncated).toBe(false);
    output.append(Buffer.from("d"));
    output.finish();
    expect(output.text).toBe("abc");
    expect(output.truncated).toBe(true);
  });

  it("flushes an incomplete final byte sequence as replacement text", () => {
    const output = new SandboxOutput(3);
    output.append(Buffer.from([0xe3]));
    output.finish();
    expect(output.text).toBe("�");
    expect(output.truncated).toBe(false);
  });
});
