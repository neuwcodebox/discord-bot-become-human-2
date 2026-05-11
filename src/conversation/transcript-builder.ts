import type { NormalizedDiscordEvent, NormalizedDiscordMessage } from "../types.js";

export function buildTranscript(
  events: NormalizedDiscordEvent[],
  options: { guildId: string; channelId: string; targetMessageIds?: string[] },
): string {
  const targetIds = new Set(options.targetMessageIds ?? []);
  const messages = materializeMessages(events);
  const lines = [
    `<transcript guild="${attr(options.guildId)}" channel="${attr(options.channelId)}" order="oldest_to_newest">`,
  ];
  for (const message of messages) {
    lines.push(renderMessage(message, targetIds.has(message.id)));
  }
  lines.push("</transcript>");
  return lines.join("\n");
}

export function materializeMessages(events: NormalizedDiscordEvent[]): NormalizedDiscordMessage[] {
  const byId = new Map<string, NormalizedDiscordMessage>();
  for (const event of events) {
    if (event.type === "message_create" || event.type === "message_update") {
      byId.set(event.messageId, event.payload);
    } else if (event.type === "message_delete") {
      const existing = byId.get(event.messageId);
      if (existing) byId.set(event.messageId, { ...existing, deletedAt: event.payload.deletedAt });
    } else if (event.type === "reaction_add" || event.type === "reaction_remove") {
      const existing = byId.get(event.messageId);
      if (!existing) continue;
      const reactions = [...existing.reactions];
      const index = reactions.findIndex((reaction) => reaction.emoji === event.payload.emoji);
      const delta = event.type === "reaction_add" ? 1 : -1;
      if (index >= 0) {
        const current = reactions[index];
        if (current) reactions[index] = { ...current, count: Math.max(0, current.count + delta) };
      } else if (delta > 0) {
        reactions.push({ emoji: event.payload.emoji, count: 1, me: false });
      }
      byId.set(event.messageId, { ...existing, reactions });
    }
  }
  return [...byId.values()].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

function renderMessage(message: NormalizedDiscordMessage, target: boolean): string {
  const flags = [
    `id="${attr(message.id)}"`,
    `uid="${attr(message.author.id)}"`,
    `name="${attr(message.author.displayName)}"`,
    `t="${attr(message.createdAt)}"`,
    message.author.isBot ? "bot" : undefined,
    message.editedAt ? "edited" : undefined,
    message.deletedAt ? "deleted" : undefined,
    target ? "target" : undefined,
  ].filter(Boolean);
  const lines = [`  <msg ${flags.join(" ")}>`];
  if (message.replyTo) {
    const replyFlags = [
      `id="${attr(message.replyTo.messageId)}"`,
      message.replyTo.authorId ? `uid="${attr(message.replyTo.authorId)}"` : undefined,
      message.replyTo.authorDisplayName ? `name="${attr(message.replyTo.authorDisplayName)}"` : undefined,
    ].filter(Boolean);
    lines.push(`    <reply ${replyFlags.join(" ")}>`);
    if (message.replyTo.contentPreview) lines.push(`      <text>${message.replyTo.contentPreview}</text>`);
    lines.push("    </reply>");
  }
  lines.push(`    <text>${message.cleanContent}</text>`);
  if (message.mentions.length > 0) {
    lines.push("    <mentions>");
    for (const mention of message.mentions) {
      lines.push(`      <mention uid="${attr(mention.id)}" name="${attr(mention.displayName)}" />`);
    }
    lines.push("    </mentions>");
  }
  if (message.attachments.length > 0) {
    lines.push("    <atts>");
    for (const attachment of message.attachments) {
      const parts = [
        `id="${attr(attachment.id)}"`,
        `file="${attr(attachment.filename)}"`,
        attachment.mimeType ? `type="${attr(attachment.mimeType)}"` : undefined,
        attachment.size !== undefined ? `bytes="${attachment.size}"` : undefined,
        `kind="${attachment.kind}"`,
        `ref="attachment://${attr(attachment.id)}"`,
      ].filter(Boolean);
      lines.push(`      <att ${parts.join(" ")} />`);
    }
    lines.push("    </atts>");
  }
  if (message.embeds.length > 0) {
    lines.push("    <embeds>");
    for (const embed of message.embeds) {
      const parts = [
        embed.title ? `title="${attr(embed.title)}"` : undefined,
        embed.url ? `url="${attr(embed.url)}"` : undefined,
        embed.imageUrl ? `image="${attr(embed.imageUrl)}"` : undefined,
      ].filter(Boolean);
      lines.push(`      <embed ${parts.join(" ")}>${embed.description ?? ""}</embed>`);
    }
    lines.push("    </embeds>");
  }
  if (message.reactions.length > 0) {
    lines.push("    <rxs>");
    for (const reaction of message.reactions) {
      lines.push(
        `      <rx emoji="${attr(reaction.emoji)}" count="${reaction.count}"${reaction.me ? " me" : ""} />`,
      );
    }
    lines.push("    </rxs>");
  }
  if (message.editedAt) lines.push(`    <edit t="${attr(message.editedAt)}" />`);
  if (message.deletedAt) lines.push(`    <deleted t="${attr(message.deletedAt)}" />`);
  lines.push("  </msg>");
  return lines.join("\n");
}

function attr(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
