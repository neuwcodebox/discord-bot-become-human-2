import { mkdtemp, writeFile } from "node:fs/promises";
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

  it("limits workspace read and search tool output", async () => {
    const root = await mkdtemp(join(tmpdir(), "dbh2-tools-"));
    await writeFile(join(root, "big.txt"), `needle ${"x".repeat(100)}`, "utf8");
    const config = {
      ...defaultConfig,
      context: {
        ...defaultConfig.context,
        maxFileReadBytes: 16,
        maxSearchResultChars: 20,
      },
    };
    const tools = createToolRegistry(config, { guildId: "g", workspaceRoot: root });
    const read = tools.find((tool) => tool.name === "workspace_read");
    const search = tools.find((tool) => tool.name === "workspace_search");

    const readResult = await read?.execute("call-read", { path: "big.txt" });
    const readDetails = JSON.parse(
      readResult?.content[0]?.type === "text" ? readResult.content[0].text : "{}",
    ) as {
      truncated?: boolean;
      limitBytes?: number;
    };
    expect(readDetails.truncated).toBe(true);
    expect(readDetails.limitBytes).toBe(16);

    const searchResult = await search?.execute("call-search", { query: "needle" });
    const searchDetails = JSON.parse(
      searchResult?.content[0]?.type === "text" ? searchResult.content[0].text : "[]",
    ) as Array<{ text: string }>;
    expect(searchDetails[0]?.text).toContain("... (truncated)");
  });
});
