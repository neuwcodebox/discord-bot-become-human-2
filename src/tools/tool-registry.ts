import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { AppConfig, ToolContext } from "../types.js";
import { fetchUrl } from "./fetch-url.js";
import { memoryPropose, memoryRead } from "./memory.js";
import { sandboxExec } from "./sandbox-exec.js";
import { summarizeText } from "./summarize.js";
import { weatherLookup } from "./weather.js";
import { workspaceRead, workspaceSearch, workspaceWrite } from "./workspace-files.js";

export function createToolRegistry(config: AppConfig, context: ToolContext): AgentTool<any>[] {
  const tools: AgentTool<any>[] = [];
  if (config.tools.workspaceFiles) {
    tools.push({
      name: "workspace_read",
      label: "Read Workspace File",
      description: "Read a UTF-8 text file inside the current guild workspace.",
      parameters: Type.Object({ path: Type.String() }),
      execute: async (_toolCallId, params) => {
        const args = params as { path: string };
        return textResult(await workspaceRead(context, args.path));
      },
    });
    tools.push({
      name: "workspace_write",
      label: "Write Workspace File",
      description: "Write a UTF-8 text file inside the current guild workspace.",
      parameters: Type.Object({ path: Type.String(), contents: Type.String() }),
      execute: async (_toolCallId, params) => {
        const args = params as { path: string; contents: string };
        return jsonResult(await workspaceWrite(context, args.path, args.contents));
      },
    });
    tools.push({
      name: "workspace_search",
      label: "Search Workspace",
      description: "Search text files inside the current guild workspace.",
      parameters: Type.Object({ query: Type.String(), maxResults: Type.Optional(Type.Number()) }),
      execute: async (_toolCallId, params) => {
        const args = params as { query: string; maxResults?: number };
        return jsonResult(
          await workspaceSearch(
            context,
            args.query,
            args.maxResults === undefined ? {} : { maxResults: args.maxResults },
          ),
        );
      },
    });
  }
  if (config.tools.memory) {
    tools.push({
      name: "memory_read",
      label: "Read Memory",
      description: "Read guild-level MEMORY.md.",
      parameters: Type.Object({}),
      execute: async () => textResult(await memoryRead(context)),
    });
    tools.push({
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
        const args = params as {
          target: string;
          confidence: number;
          note: string;
          evidenceMessageIds: string[];
        };
        return jsonResult(await memoryPropose(context, { ...args, source: "conversation" }));
      },
    });
  }
  if (config.tools.summarize) {
    tools.push({
      name: "summarize_text",
      label: "Summarize Text",
      description: "Compress a long text without inventing facts.",
      parameters: Type.Object({ text: Type.String(), maxChars: Type.Optional(Type.Number()) }),
      execute: async (_toolCallId, params) => {
        const args = params as { text: string; maxChars?: number };
        return jsonResult(await summarizeText(args));
      },
    });
  }
  if (config.tools.weather) {
    tools.push({
      name: "weather_lookup",
      label: "Weather Lookup",
      description: "Look up weather or forecast information for a location.",
      parameters: Type.Object({ location: Type.String(), date: Type.Optional(Type.String()) }),
      execute: async (_toolCallId, params) => {
        const args = params as { location: string; date?: string };
        return jsonResult(await weatherLookup(args));
      },
    });
  }
  if (config.tools.fetchUrl) {
    tools.push({
      name: "fetch_url",
      label: "Fetch URL",
      description: "Fetch a URL with timeout, content-type, and size limits.",
      parameters: Type.Object({ url: Type.String() }),
      execute: async (_toolCallId, params) => {
        const args = params as { url: string };
        return jsonResult(await fetchUrl({ url: args.url }));
      },
    });
  }
  if (config.tools.sandboxExec) {
    tools.push({
      name: "sandbox_exec",
      label: "Sandbox Exec",
      description: "Execute an argv command in a bwrap sandbox bound to the current guild workspace.",
      parameters: Type.Object({ argv: Type.Array(Type.String()) }),
      execute: async (_toolCallId, params) => {
        const args = params as { argv: string[] };
        return jsonResult(await sandboxExec(context, config, args));
      },
    });
  }
  return tools;
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
