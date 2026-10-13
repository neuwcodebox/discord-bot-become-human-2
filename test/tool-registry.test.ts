import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defaultConfig } from "../src/config.js";
import { AttachmentCache } from "../src/discord/attachment-cache.js";
import type { DiscordActionRuntime } from "../src/tools/discord-actions.js";
import { createToolRegistry } from "../src/tools/tool-registry.js";
import type { RuntimeAgentTool } from "../src/types.js";
import { createTestWorkspace } from "./helpers/workspace.js";

const testContext = { guildId: "g", workspaceRoot: "/unused" };

function requireTool(tools: RuntimeAgentTool[], name: string): RuntimeAgentTool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing tool: ${name}`);
  return tool;
}

function parseJsonResult(result: AgentToolResult<unknown>): unknown {
  const content = result.content[0];
  if (content?.type !== "text") throw new Error("Expected a JSON text tool result.");
  return JSON.parse(content.text);
}

function discordActions(): DiscordActionRuntime {
  return {
    react: vi.fn(async () => {}),
    unreact: vi.fn(async () => {}),
    editOwn: vi.fn(async () => {}),
    deleteOwn: vi.fn(async () => {}),
    getMember: vi.fn(async () => ({ id: "member" })),
    getChannel: vi.fn(async () => ({ id: "channel" })),
    searchHistory: vi.fn(async () => []),
    sendMessage: vi.fn(async () => ({ messageId: "sent" })),
  };
}

describe("tool registry", () => {
  it("registers enabled tools when all integrations are available", () => {
    const tools = createToolRegistry(
      { ...defaultConfig, search: { provider: "tavily", apiKey: "test-key" } },
      testContext,
      { discordActions: discordActions(), attachmentCache: new AttachmentCache() },
    );

    expect(new Set(tools.map((tool) => tool.name))).toEqual(
      new Set([
        "workspace_read",
        "workspace_write",
        "workspace_search",
        "memory_propose",
        "fetch_url",
        "read_attachment",
        "discord_react",
        "discord_unreact",
        "discord_edit_own",
        "discord_delete_own",
        "discord_get_member",
        "discord_get_channel",
        "discord_search_history",
        "discord_send_message",
        "search_internet",
        "sandbox_exec",
      ]),
    );
  });

  it("omits tools whose integrations or search configuration are unavailable", () => {
    const tools = createToolRegistry(defaultConfig, testContext);

    expect(new Set(tools.map((tool) => tool.name))).toEqual(
      new Set([
        "workspace_read",
        "workspace_write",
        "workspace_search",
        "memory_propose",
        "fetch_url",
        "sandbox_exec",
      ]),
    );
  });

  it("respects disabled tools even when their integrations are available", () => {
    const tools = createToolRegistry(
      {
        ...defaultConfig,
        search: { provider: "tavily", apiKey: "test-key" },
        tools: {
          workspaceFiles: false,
          memory: false,
          discordActions: false,
          fetchUrl: false,
          readAttachment: false,
          sandboxExec: false,
          searchInternet: false,
        },
      },
      testContext,
      { discordActions: discordActions(), attachmentCache: new AttachmentCache() },
    );

    expect(tools).toEqual([]);
  });

  it("enforces the workspace write policy before writing", async () => {
    const root = await createTestWorkspace("dbh2-tools-");
    const tools = createToolRegistry(
      defaultConfig,
      { ...testContext, workspaceRoot: root },
      {
        writePolicy(path) {
          if (path !== "memory/MEMORY.md") throw new Error(`blocked ${path}`);
        },
      },
    );
    const write = requireTool(tools, "workspace_write");

    await expect(write.execute("call-1", { path: "users/1/USER.md", contents: "no" })).rejects.toThrow(
      /blocked/,
    );
    await expect(readFile(join(root, "users/1/USER.md"))).rejects.toMatchObject({ code: "ENOENT" });
    const result = await write.execute("call-2", { path: "memory/MEMORY.md", contents: "yes" });
    expect(parseJsonResult(result)).toEqual({ path: "memory/MEMORY.md" });
    await expect(readFile(join(root, "memory/MEMORY.md"), "utf8")).resolves.toBe("yes");
  });

  it("limits workspace read and search tool output", async () => {
    const root = await createTestWorkspace("dbh2-tools-");
    await writeFile(join(root, "big.txt"), `needle ${"x".repeat(100)}`, "utf8");
    const config = {
      ...defaultConfig,
      context: {
        ...defaultConfig.context,
        maxFileReadBytes: 32,
        maxSearchResultChars: 20,
      },
    };
    const tools = createToolRegistry(config, { ...testContext, workspaceRoot: root });
    const read = requireTool(tools, "workspace_read");
    const search = requireTool(tools, "workspace_search");

    const readResult = await read.execute("call-read", { path: "big.txt" });
    const readDetails = z
      .object({ truncated: z.boolean(), limitBytes: z.number(), text: z.string() })
      .parse(parseJsonResult(readResult));
    expect(readDetails.truncated).toBe(true);
    expect(readDetails.limitBytes).toBe(32);
    expect(Buffer.byteLength(readDetails.text, "utf8")).toBeLessThanOrEqual(32);

    const searchResult = await search.execute("call-search", { query: "needle" });
    const searchDetails = z.array(z.object({ text: z.string() })).parse(parseJsonResult(searchResult));
    expect(searchDetails).toEqual([{ text: expect.stringContaining("... (truncated)") }]);
    expect(searchDetails.every((match) => match.text.length <= 20)).toBe(true);
  });

  it("forwards file-only Discord messages and returns their message ID", async () => {
    const actions = discordActions();
    const tools = createToolRegistry(defaultConfig, testContext, { discordActions: actions });
    const send = requireTool(tools, "discord_send_message");
    const result = await send.execute("call-send", { files: ["images/result.png"] });

    expect(actions.sendMessage).toHaveBeenCalledWith(undefined, ["images/result.png"]);
    expect(parseJsonResult(result)).toEqual({ messageId: "sent" });
  });

  it("propagates Discord ownership failures", async () => {
    const actions = discordActions();
    const error = new Error("discord_delete_own can delete only bot-owned messages.");
    vi.mocked(actions.deleteOwn).mockRejectedValue(error);
    const tools = createToolRegistry(defaultConfig, testContext, { discordActions: actions });
    const remove = requireTool(tools, "discord_delete_own");

    await expect(remove.execute("call-delete", { messageId: "other-user-message" })).rejects.toBe(error);
  });
});
