import { Type } from "@earendil-works/pi-ai";
import type { AppConfig, RuntimeAgentTool, ToolContext } from "../types.js";
import { readAttachmentToolContent } from "./attachment.js";
import { createDiscordActionTools } from "./discord-action-tools.js";
import { fetchUrl } from "./fetch-url.js";
import { createImageTools } from "./image-tools.js";
import { memoryPropose } from "./memory.js";
import { sandboxExec } from "./sandbox-exec.js";
import { searchInternet } from "./search-internet.js";
import { defineTool, jsonResult } from "./tool-definition.js";
import type { ToolIntegrations } from "./types.js";
import { workspaceRead, workspaceSearch, workspaceWrite } from "./workspace-files.js";

export function createToolRegistry(
  config: AppConfig,
  context: ToolContext,
  integrations: ToolIntegrations = {},
): RuntimeAgentTool[] {
  const tools: RuntimeAgentTool[] = [];
  if (config.tools.imageGeneration && config.llm.provider === "openai-codex" && !integrations.writePolicy) {
    tools.push(...createImageTools(config.llm, config.images, context, integrations.attachmentCache));
  }
  if (config.tools.workspaceFiles) {
    tools.push(
      defineTool({
        name: "workspace_read",
        label: "Read Workspace File",
        description: "Read a UTF-8 text file inside the current guild workspace.",
        parameters: Type.Object({ path: Type.String() }),
        execute: async (_toolCallId, params) =>
          jsonResult(
            await workspaceRead(context, params.path, { maxBytes: config.context.maxFileReadBytes }),
          ),
      }),
      defineTool({
        name: "workspace_write",
        label: "Write Workspace File",
        description: "Write a UTF-8 text file inside the current guild workspace.",
        parameters: Type.Object({ path: Type.String(), contents: Type.String() }),
        execute: async (_toolCallId, params, signal) => {
          integrations.writePolicy?.(params.path);
          return jsonResult(await workspaceWrite(context, params.path, params.contents, signal));
        },
      }),
      defineTool({
        name: "workspace_search",
        label: "Search Workspace",
        description: "Search text files inside the current guild workspace.",
        parameters: Type.Object({ query: Type.String(), maxResults: Type.Optional(Type.Number()) }),
        execute: async (_toolCallId, params) =>
          jsonResult(
            await workspaceSearch(context, params.query, {
              maxResultChars: config.context.maxSearchResultChars,
              ...(params.maxResults === undefined ? {} : { maxResults: params.maxResults }),
            }),
          ),
      }),
    );
  }
  if (config.tools.memory) {
    tools.push(
      defineTool({
        name: "memory_propose",
        label: "Propose Memory",
        description:
          "Propose a durable fact or preference for later memory review, with its target file and message evidence.",
        parameters: Type.Object({
          target: Type.String(),
          confidence: Type.Number(),
          note: Type.String(),
          evidenceMessageIds: Type.Array(Type.String()),
        }),
        execute: async (_toolCallId, params, signal) =>
          jsonResult(await memoryPropose(context, { ...params, source: "conversation" }, signal)),
      }),
    );
  }
  if (config.tools.fetchUrl) {
    tools.push(
      defineTool({
        name: "fetch_url",
        label: "Fetch URL",
        description: "Fetch a URL with timeout, content-type, and size limits.",
        parameters: Type.Object({ url: Type.String() }),
        execute: async (_toolCallId, params, signal) =>
          jsonResult(
            await fetchUrl({
              url: params.url,
              maxBytes: config.context.maxFileReadBytes,
              ...(signal ? { signal } : {}),
            }),
          ),
      }),
    );
  }
  if (config.tools.readAttachment && integrations.attachmentCache) {
    const attachmentCache = integrations.attachmentCache;
    tools.push(
      defineTool({
        name: "read_attachment",
        label: "Read Attachment",
        description: "Read an attachment through its attachment:// reference.",
        parameters: Type.Object({ ref: Type.String(), maxBytes: Type.Optional(Type.Number()) }),
        execute: async (_toolCallId, params, signal) =>
          readAttachmentToolContent(attachmentCache, {
            ...params,
            maxBytes: params.maxBytes ?? config.context.maxFileReadBytes,
            ...(signal ? { signal } : {}),
          }),
      }),
    );
  }
  if (config.tools.discordActions && integrations.discordActions) {
    tools.push(...createDiscordActionTools(integrations.discordActions));
  }
  if (config.tools.searchInternet && config.search) {
    const { provider: kind, apiKey } = config.search;
    tools.push(
      defineTool({
        name: "search_internet",
        label: "Search Internet",
        description: "Search the internet for up-to-date information.",
        parameters: Type.Object({ query: Type.String() }),
        execute: async (_toolCallId, params, signal) =>
          jsonResult(await searchInternet(params, { kind, apiKey }, signal)),
      }),
    );
  }
  if (config.tools.sandboxExec) {
    tools.push(
      defineTool({
        name: "sandbox_exec",
        label: "Sandbox Exec",
        description: config.sandbox.enabled
          ? "Execute a command in an isolated environment with the current guild workspace as its writable area."
          : "Execute an argv command in the current guild workspace directory (no sandbox isolation).",
        parameters: Type.Object({ argv: Type.Array(Type.String()) }),
        execute: async (_toolCallId, params, signal) =>
          jsonResult(await sandboxExec(context, config, params, signal)),
      }),
    );
  }
  return tools;
}
