import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { readDirectoryIfExists, readTextIfExists } from "../src/storage/files.js";
import { readCursor, readJsonl } from "../src/storage/jsonl.js";
import { createTestWorkspace } from "./helpers/workspace.js";

describe("optional storage reads", () => {
  let root = "";

  beforeEach(async () => {
    root = await createTestWorkspace("dbh2-storage-");
  });

  it("reads existing UTF-8 files and directory entries", async () => {
    await writeFile(join(root, "MEMORY.md"), "서버 기억\n", "utf8");
    await mkdir(join(root, "skills"));

    await expect(readTextIfExists(join(root, "MEMORY.md"))).resolves.toBe("서버 기억\n");
    expect((await readDirectoryIfExists(root)).sort()).toEqual(["MEMORY.md", "skills"]);
  });

  it("uses empty defaults only for missing files and directories", async () => {
    const missing = join(root, "missing", "entry");

    await expect(readTextIfExists(missing)).resolves.toBe("");
    await expect(readDirectoryIfExists(missing)).resolves.toEqual([]);
    await expect(readCursor(missing)).resolves.toBe(0);
    await expect(readJsonl<unknown>(missing)).resolves.toEqual([]);
  });

  it("propagates errors when a path component is a file", async () => {
    const file = join(root, "file");
    await writeFile(file, "contents", "utf8");
    const invalid = join(file, "entry");

    await expect(readTextIfExists(invalid)).rejects.toMatchObject({ code: "ENOTDIR" });
    await expect(readDirectoryIfExists(invalid)).rejects.toMatchObject({ code: "ENOTDIR" });
    await expect(readCursor(invalid)).rejects.toMatchObject({ code: "ENOTDIR" });
    await expect(readJsonl<unknown>(invalid)).rejects.toMatchObject({ code: "ENOTDIR" });
  });

  it("propagates directory read errors when text is expected", async () => {
    await expect(readTextIfExists(root)).rejects.toMatchObject({ code: "EISDIR" });
  });

  it("preserves cursor parsing and invalid-content fallback", async () => {
    const path = join(root, ".cursor");
    await writeFile(path, " 42\n", "utf8");
    await expect(readCursor(path)).resolves.toBe(42);
    await writeFile(path, "invalid", "utf8");
    await expect(readCursor(path)).resolves.toBe(0);
  });
});
