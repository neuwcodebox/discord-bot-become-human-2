import type { NormalizedDiscordMessage } from "../types.js";

export class AttachmentCache {
  private readonly attachments = new Map<string, NormalizedDiscordMessage["attachments"][number]>();
  private readonly guildIds = new Map<string, string>();

  remember(message: NormalizedDiscordMessage): void {
    for (const attachment of message.attachments) {
      this.attachments.set(attachment.id, attachment);
      this.guildIds.set(attachment.id, message.guildId);
    }
  }

  get(id: string): NormalizedDiscordMessage["attachments"][number] | undefined {
    return this.attachments.get(id);
  }

  getForGuild(id: string, guildId: string): NormalizedDiscordMessage["attachments"][number] | undefined {
    return this.guildIds.get(id) === guildId ? this.attachments.get(id) : undefined;
  }
}
