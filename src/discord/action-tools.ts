import type { Client, MessageReaction, TextBasedChannel } from "discord.js";

export class DiscordActionTools {
  constructor(private readonly client: Client) {}

  async react(channel: TextBasedChannel, messageId: string, emoji: string): Promise<void> {
    const message = await channel.messages.fetch(messageId);
    await message.react(emoji);
  }

  async unreact(reaction: MessageReaction): Promise<void> {
    await reaction.users.remove(this.client.user?.id);
  }

  async editOwn(channel: TextBasedChannel, messageId: string, content: string): Promise<void> {
    const message = await channel.messages.fetch(messageId);
    if (message.author.id !== this.client.user?.id)
      throw new Error("discord_edit_own can edit only bot-owned messages.");
    await message.edit({ content, allowedMentions: { parse: [], repliedUser: false } });
  }

  async deleteOwn(channel: TextBasedChannel, messageId: string): Promise<void> {
    const message = await channel.messages.fetch(messageId);
    if (message.author.id !== this.client.user?.id)
      throw new Error("discord_delete_own can delete only bot-owned messages.");
    await message.delete();
  }
}
