import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type TSchema, Type } from "@earendil-works/pi-ai";
import type { AttachmentCache } from "../discord/attachment-cache.js";
import { childLogger } from "../logger.js";
import type { AppConfig, RuntimeAgentTool, ToolContext } from "../types.js";
import { readAttachmentToolContent } from "./attachment.js";
import type { DiscordActionRuntime } from "./discord-actions.js";
import { fetchUrl } from "./fetch-url.js";
import { memoryPropose, memoryRead } from "./memory.js";
import { sandboxExec } from "./sandbox-exec.js";
import { searchInternet } from "./search-internet.js";
import { summarizeText } from "./summarize.js";
import { weatherLookup } from "./weather.js";
import { workspaceRead, workspaceSearch, workspaceWrite } from "./workspace-files.js";

const log = childLogger("tools");

export function createToolRegistry(
  config: AppConfig,
  context: ToolContext,
  integrations: {
    discordActions?: DiscordActionRuntime;
    attachmentCache?: AttachmentCache;
    writePolicy?: (path: string) => void;
  } = {},
): RuntimeAgentTool[] {
  const tools: RuntimeAgentTool[] = [];
  if (config.tools.workspaceFiles) {
    addTool(tools, {
      name: "workspace_read",
      label: "Read Workspace File",
      description: "Read a UTF-8 text file inside the current guild workspace.",
      parameters: Type.Object({ path: Type.String() }),
      execute: async (_toolCallId, params) => {
        return jsonResult(
          await workspaceRead(context, params.path, { maxBytes: config.context.maxFileReadBytes }),
        );
      },
    });
    addTool(tools, {
      name: "workspace_write",
      label: "Write Workspace File",
      description: "Write a UTF-8 text file inside the current guild workspace.",
      parameters: Type.Object({ path: Type.String(), contents: Type.String() }),
      execute: async (_toolCallId, params) => {
        integrations.writePolicy?.(params.path);
        return jsonResult(await workspaceWrite(context, params.path, params.contents));
      },
    });
    addTool(tools, {
      name: "workspace_search",
      label: "Search Workspace",
      description: "Search text files inside the current guild workspace.",
      parameters: Type.Object({ query: Type.String(), maxResults: Type.Optional(Type.Number()) }),
      execute: async (_toolCallId, params) => {
        return jsonResult(
          await workspaceSearch(
            context,
            params.query,
            params.maxResults === undefined
              ? { maxResultChars: config.context.maxSearchResultChars }
              : { maxResults: params.maxResults, maxResultChars: config.context.maxSearchResultChars },
          ),
        );
      },
    });
  }
  if (config.tools.memory) {
    addTool(tools, {
      name: "memory_read",
      label: "Read Memory",
      description: "Read guild-level MEMORY.md.",
      parameters: Type.Object({}),
      execute: async () => textResult(await memoryRead(context)),
    });
    addTool(tools, {
      name: "memory_propose",
      label: "Propose Memory",
      description: "Append a memory candidate to memory/inbox.jsonl.",
      parameters: Type.Object({
        target: Type.String(),
        confidence: Type.Number(),
        note: Type.String(),
        evidenceMessageIds: Type.Array(Type.String()),
      }),
      execute: async (_toolCallId, params) => {
        return jsonResult(await memoryPropose(context, { ...params, source: "conversation" }));
      },
    });
  }
  if (config.tools.summarize) {
    addTool(tools, {
      name: "summarize_text",
      label: "Summarize Text",
      description: "Compress a long text without inventing facts.",
      parameters: Type.Object({ text: Type.String(), maxChars: Type.Optional(Type.Number()) }),
      execute: async (_toolCallId, params) => {
        return jsonResult(await summarizeText(params));
      },
    });
  }
  if (config.tools.weather) {
    addTool(tools, {
      name: "weather_lookup",
      label: "Weather Lookup",
      description: "Look up weather or forecast information for a location.",
      parameters: Type.Object({ location: Type.String(), date: Type.Optional(Type.String()) }),
      execute: async (_toolCallId, params) => {
        return jsonResult(await weatherLookup(params));
      },
    });
  }
  if (config.tools.fetchUrl) {
    addTool(tools, {
      name: "fetch_url",
      label: "Fetch URL",
      description: "Fetch a URL with timeout, content-type, and size limits.",
      parameters: Type.Object({ url: Type.String() }),
      execute: async (_toolCallId, params) => {
        return jsonResult(await fetchUrl({ url: params.url, maxBytes: config.context.maxFileReadBytes }));
      },
    });
  }
  if (config.tools.readAttachment && integrations.attachmentCache) {
    const attachmentCache = integrations.attachmentCache;
    addTool(tools, {
      name: "read_attachment",
      label: "Read Attachment",
      description: "Read an attachment through its attachment:// reference.",
      parameters: Type.Object({ ref: Type.String(), maxBytes: Type.Optional(Type.Number()) }),
      execute: async (_toolCallId, params) => {
        return readAttachmentToolContent(attachmentCache, {
          ...params,
          maxBytes: params.maxBytes ?? config.context.maxFileReadBytes,
        });
      },
    });
  }
  if (config.tools.discordActions && integrations.discordActions) {
    const discordActions = integrations.discordActions;
    addTool(tools, {
      name: "discord_react",
      label: "React",
      description: "Add an emoji reaction to a message.",
      parameters: Type.Object({ messageId: Type.String(), emoji: Type.String() }),
      execute: async (_toolCallId, params) => {
        await discordActions.react(params.messageId, params.emoji);
        return jsonResult({ ok: true });
      },
    });
    addTool(tools, {
      name: "discord_unreact",
      label: "Unreact",
      description: "Remove this bot's emoji reaction from a message.",
      parameters: Type.Object({ messageId: Type.String(), emoji: Type.String() }),
      execute: async (_toolCallId, params) => {
        await discordActions.unreact(params.messageId, params.emoji);
        return jsonResult({ ok: true });
      },
    });
    addTool(tools, {
      name: "discord_edit_own",
      label: "Edit Own Message",
      description: "Edit a bot-owned Discord message only.",
      parameters: Type.Object({ messageId: Type.String(), content: Type.String() }),
      execute: async (_toolCallId, params) => {
        await discordActions.editOwn(params.messageId, params.content);
        return jsonResult({ ok: true });
      },
    });
    addTool(tools, {
      name: "discord_delete_own",
      label: "Delete Own Message",
      description: "Delete a bot-owned Discord message only.",
      parameters: Type.Object({ messageId: Type.String() }),
      execute: async (_toolCallId, params) => {
        await discordActions.deleteOwn(params.messageId);
        return jsonResult({ ok: true });
      },
    });
    addTool(tools, {
      name: "discord_get_member",
      label: "Get Guild Member",
      description: "Read public guild member metadata.",
      parameters: Type.Object({ userId: Type.String() }),
      execute: async (_toolCallId, params) => {
        return jsonResult(await discordActions.getMember(params.userId));
      },
    });
    addTool(tools, {
      name: "discord_get_channel",
      label: "Get Channel",
      description: "Read current channel metadata.",
      parameters: Type.Object({}),
      execute: async () => jsonResult(await discordActions.getChannel()),
    });
    addTool(tools, {
      name: "discord_search_history",
      label: "Search Discord History",
      description: "Search this guild workspace's events.jsonl and history.jsonl.",
      parameters: Type.Object({ query: Type.String(), maxResults: Type.Optional(Type.Number()) }),
      execute: async (_toolCallId, params) => {
        return jsonResult(await discordActions.searchHistory(params.query, params.maxResults));
      },
    });
    addTool(tools, {
      name: "discord_send_message",
      label: "Send Message",
      description:
        "Send an additional message to the current channel. Your main text reply is always sent separately — use this only when content should appear as an independent message at a specific point in the conversation.",
      parameters: Type.Object({ content: Type.String() }),
      execute: async (_toolCallId, params) => {
        return jsonResult(await discordActions.sendMessage(params.content));
      },
    });
  }
  if (config.tools.searchInternet && config.search) {
    const { provider: kind, apiKey } = config.search;
    addTool(tools, {
      name: "search_internet",
      label: "Search Internet",
      description: "Search the internet for up-to-date information.",
      parameters: Type.Object({ query: Type.String() }),
      execute: async (_id, params) => jsonResult(await searchInternet(params, { kind, apiKey })),
    });
  }
  if (config.tools.sandboxExec) {
    addTool(tools, {
      name: "sandbox_exec",
      label: "Sandbox Exec",
      description: "Execute an argv command in a bwrap sandbox bound to the current guild workspace.",
      parameters: Type.Object({ argv: Type.Array(Type.String()) }),
      execute: async (_toolCallId, params) => {
        return jsonResult(await sandboxExec(context, config, params));
      },
    });
  }
  return tools;
}

function addTool<TParameters extends TSchema, TDetails>(
  tools: RuntimeAgentTool[],
  tool: AgentTool<TParameters, TDetails>,
): void {
  tools.push(wrapToolLogging(tool) as unknown as RuntimeAgentTool);
}

function wrapToolLogging<TParameters extends TSchema, TDetails>(
  tool: AgentTool<TParameters, TDetails>,
): AgentTool<TParameters, TDetails> {
  return {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const startedAt = Date.now();
      log.debug(
        { toolName: tool.name, toolCallId, paramKeys: Object.keys(params) },
        "tool execution started",
      );
      try {
        const result = await tool.execute(toolCallId, params, signal, onUpdate);
        log.debug(
          {
            toolName: tool.name,
            toolCallId,
            durationMs: Date.now() - startedAt,
            isError: false,
          },
          "tool execution completed",
        );
        return result;
      } catch (error) {
        log.warn(
          {
            err: error,
            toolName: tool.name,
            toolCallId,
            durationMs: Date.now() - startedAt,
          },
          "tool execution failed",
        );
        throw error;
      }
    },
  };
}

function textResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    details: { text },
  };
}

function jsonResult(value: unknown) {
  return textResult(JSON.stringify(value, null, 2));
}
