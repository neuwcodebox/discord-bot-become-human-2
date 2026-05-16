import type { AttachmentBuilder, Message, MessageMentionOptions, TextBasedChannel } from "discord.js";

const replyNewerMessageThreshold = 2;

export const safeAllowedMentions: MessageMentionOptions = {
  parse: [],
  repliedUser: false,
};

type SendPayload = {
  content: string;
  allowedMentions: MessageMentionOptions;
  files?: AttachmentBuilder[];
};

type SendableChannel = TextBasedChannel & {
  send: (options: SendPayload) => Promise<Message<boolean>>;
};

export async function sendDiscordMessage(
  channel: TextBasedChannel,
  content: string,
  options: { replyTo?: Message<boolean>; files?: AttachmentBuilder[] } = {},
): Promise<Message<boolean>> {
  const { replyTo, files } = options;
  const fileOptions = files && files.length > 0 ? { files } : {};
  if (replyTo && (await shouldReplyToMessage(replyTo))) {
    return replyTo.reply({
      content,
      ...fileOptions,
      allowedMentions: safeAllowedMentions,
    });
  }
  return (channel as SendableChannel).send({
    content,
    ...fileOptions,
    allowedMentions: safeAllowedMentions,
  });
}

export async function shouldReplyToMessage(message: Message<boolean>): Promise<boolean> {
  try {
    const newerMessages = await message.channel.messages.fetch({
      after: message.id,
      limit: replyNewerMessageThreshold,
    });
    return newerMessages.size >= replyNewerMessageThreshold;
  } catch {
    return false;
  }
}

export async function editOwnMessage(message: Message<boolean>, content: string): Promise<Message<boolean>> {
  if (!message.editable) throw new Error("Message is not editable by this bot.");
  return message.edit({
    content,
    allowedMentions: safeAllowedMentions,
  });
}
