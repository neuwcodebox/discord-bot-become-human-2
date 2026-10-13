import { Type } from "@earendil-works/pi-ai";
import type { RuntimeAgentTool } from "../types.js";
import type { DiscordActionRuntime } from "./discord-actions.js";
import { defineTool, jsonResult } from "./tool-definition.js";

export function createDiscordActionTools(actions: DiscordActionRuntime): RuntimeAgentTool[] {
  return [
    defineTool({
      name: "discord_react",
      label: "React",
      description: "Add an emoji reaction to a message.",
      parameters: Type.Object({ messageId: Type.String(), emoji: Type.String() }),
      execute: async (_toolCallId, params) => {
        await actions.react(params.messageId, params.emoji);
        return jsonResult({ ok: true });
      },
    }),
    defineTool({
      name: "discord_unreact",
      label: "Unreact",
      description: "Remove this bot's emoji reaction from a message.",
      parameters: Type.Object({ messageId: Type.String(), emoji: Type.String() }),
      execute: async (_toolCallId, params) => {
        await actions.unreact(params.messageId, params.emoji);
        return jsonResult({ ok: true });
      },
    }),
    defineTool({
      name: "discord_edit_own",
      label: "Edit Own Message",
      description: "Edit a bot-owned Discord message only.",
      parameters: Type.Object({ messageId: Type.String(), content: Type.String() }),
      execute: async (_toolCallId, params) => {
        await actions.editOwn(params.messageId, params.content);
        return jsonResult({ ok: true });
      },
    }),
    defineTool({
      name: "discord_delete_own",
      label: "Delete Own Message",
      description: "Delete a bot-owned Discord message only.",
      parameters: Type.Object({ messageId: Type.String() }),
      execute: async (_toolCallId, params) => {
        await actions.deleteOwn(params.messageId);
        return jsonResult({ ok: true });
      },
    }),
    defineTool({
      name: "discord_get_member",
      label: "Get Guild Member",
      description: "Read public guild member metadata.",
      parameters: Type.Object({ userId: Type.String() }),
      execute: async (_toolCallId, params) => jsonResult(await actions.getMember(params.userId)),
    }),
    defineTool({
      name: "discord_get_channel",
      label: "Get Channel",
      description: "Read current channel metadata.",
      parameters: Type.Object({}),
      execute: async () => jsonResult(await actions.getChannel()),
    }),
    defineTool({
      name: "discord_search_history",
      label: "Search Discord History",
      description: "Search this guild workspace's events.jsonl and history.jsonl.",
      parameters: Type.Object({ query: Type.String(), maxResults: Type.Optional(Type.Number()) }),
      execute: async (_toolCallId, params) =>
        jsonResult(await actions.searchHistory(params.query, params.maxResults)),
    }),
    defineTool({
      name: "discord_send_message",
      label: "Send Message",
      description:
        "Send an additional message to the current channel. Your main text reply is always sent separately — use this only when content should appear as an independent message at a specific point in the conversation.",
      parameters: Type.Object({
        content: Type.Optional(Type.String()),
        files: Type.Optional(
          Type.Array(Type.String(), {
            description:
              "Workspace-relative paths of files to attach. Each file must already exist in the workspace.",
          }),
        ),
      }),
      execute: async (_toolCallId, params) =>
        jsonResult(await actions.sendMessage(params.content, params.files)),
    }),
  ];
}
