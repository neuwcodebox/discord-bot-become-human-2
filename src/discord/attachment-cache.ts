import type { NormalizedDiscordMessage } from "../types.js";

export class AttachmentCache {
  private readonly attachments = new Map<string, NormalizedDiscordMessage["attachments"][number]>();

  remember(message: NormalizedDiscordMessage): void {
    for (const attachment of message.attachments) {
      this.attachments.set(attachment.id, attachment);
    }
  }

  get(id: string): NormalizedDiscordMessage["attachments"][number] | undefined {
    return this.attachments.get(id);
  }
}
