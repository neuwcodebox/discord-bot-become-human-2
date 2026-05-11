import type { Message, MessageMentionOptions, TextBasedChannel } from "discord.js";

export const safeAllowedMentions: MessageMentionOptions = {
  parse: [],
  repliedUser: false,
};

export async function sendDiscordMessage(
  channel: TextBasedChannel,
  content: string,
  options: { replyTo?: Message<boolean> } = {},
): Promise<Message<boolean>> {
  if (options.replyTo) {
    return options.replyTo.reply({
      content,
      allowedMentions: safeAllowedMentions,
    });
  }
  return (
    channel as TextBasedChannel & {
      send: (options: {
        content: string;
        allowedMentions: MessageMentionOptions;
      }) => Promise<Message<boolean>>;
    }
  ).send({
    content,
    allowedMentions: safeAllowedMentions,
  });
}

export async function editOwnMessage(message: Message<boolean>, content: string): Promise<Message<boolean>> {
  if (!message.editable) throw new Error("Message is not editable by this bot.");
  return message.edit({
    content,
    allowedMentions: safeAllowedMentions,
  });
}
