import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertInsideWorkspace, assertWritablePathInsideWorkspace } from "../src/paths/workspace-guard.js";

describe("workspace guard", () => {
  it("allows paths inside the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "dbh2-"));
    await writeFile(join(root, "MEMORY.md"), "ok", "utf8");

    const safe = await assertInsideWorkspace(root, "MEMORY.md");

    await expect(readFile(safe, "utf8")).resolves.toBe("ok");
  });

  it("rejects parent traversal", async () => {
    const root = await mkdtemp(join(tmpdir(), "dbh2-"));

    await expect(assertInsideWorkspace(root, "../outside.txt")).rejects.toThrow(/escapes guild workspace/);
  });

  it("rejects symlink traversal outside the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "dbh2-"));
    const outside = await mkdtemp(join(tmpdir(), "dbh2-outside-"));
    await writeFile(join(outside, "secret.txt"), "secret", "utf8");
    await symlink(outside, join(root, "link"));

    await expect(assertInsideWorkspace(root, "link/secret.txt")).rejects.toThrow(/escapes guild workspace/);
  });

  it("checks new file parent directories before writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "dbh2-"));
    await mkdir(join(root, "memory"));

    await expect(assertWritablePathInsideWorkspace(root, "memory/new.txt")).resolves.toContain("new.txt");
    await expect(assertWritablePathInsideWorkspace(root, "../new.txt")).rejects.toThrow(
      /escapes guild workspace/,
    );
  });
});
