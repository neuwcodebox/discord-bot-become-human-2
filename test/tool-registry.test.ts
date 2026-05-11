import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config.js";
import { createToolRegistry } from "../src/tools/tool-registry.js";

describe("tool registry", () => {
  it("enforces optional workspace write policy before writing", async () => {
    const root = await mkdtemp(join(tmpdir(), "dbh2-tools-"));
    const tools = createToolRegistry(
      defaultConfig,
      { guildId: "g", workspaceRoot: root },
      {
        writePolicy(path) {
          if (path !== "memory/MEMORY.md") throw new Error(`blocked ${path}`);
        },
      },
    );
    const write = tools.find((tool) => tool.name === "workspace_write");
    expect(write).toBeDefined();

    await expect(write?.execute("call-1", { path: "users/1/USER.md", contents: "no" })).rejects.toThrow(
      /blocked/,
    );
    await expect(
      write?.execute("call-2", { path: "memory/MEMORY.md", contents: "yes" }),
    ).resolves.toMatchObject({ details: { text: expect.stringContaining("MEMORY.md") } });
  });
});
