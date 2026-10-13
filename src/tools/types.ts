import type { AttachmentCache } from "../discord/attachment-cache.js";
import type { DiscordActionRuntime } from "./discord-actions.js";

export type ToolIntegrations = {
  discordActions?: DiscordActionRuntime;
  attachmentCache?: AttachmentCache;
  writePolicy?: (path: string) => void;
};
