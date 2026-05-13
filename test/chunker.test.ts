import { describe, expect, it } from "vitest";
import { splitText } from "../src/discord/chunker.js";

describe("splitText", () => {
  it("returns a single chunk when text is within hardLimit", () => {
    expect(splitText("hello world", 1800, 1950)).toEqual(["hello world"]);
  });

  it("splits at a paragraph boundary when text exceeds hardLimit", () => {
    const part1 = "a".repeat(900);
    const part2 = "b".repeat(900);
    const text = `${part1}\n\n${part2}`;
    const chunks = splitText(text, 1000, 1100);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe(part1);
    expect(chunks[1]).toBe(part2);
  });

  it("splits at a line boundary when no paragraph boundary fits", () => {
    const part1 = "a".repeat(900);
    const part2 = "b".repeat(900);
    const text = `${part1}\n${part2}`;
    const chunks = splitText(text, 1000, 1100);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe(part1);
    expect(chunks[1]).toBe(part2);
  });

  it("handles multiple splits for very long text", () => {
    const section = "word ".repeat(400); // ~2000 chars each
    const text = `${section}\n${section}\n${section}`;
    const chunks = splitText(text, 1800, 1950);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(1950);
    }
    expect(chunks.join(" ").replace(/\s+/g, " ").trim()).toBe(text.replace(/\s+/g, " ").trim());
  });

  it("returns empty array for empty string", () => {
    expect(splitText("", 1800, 1950)).toEqual([]);
  });
});
