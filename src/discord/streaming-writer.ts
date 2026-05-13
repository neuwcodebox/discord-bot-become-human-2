import type { Message, TextBasedChannel } from "discord.js";
import type { AppConfig } from "../types.js";
import { chooseSplit } from "./chunker.js";
import { editOwnMessage, sendDiscordMessage } from "./sender.js";

export type StreamingSegment = {
  messageId: string;
  logicalText: string;
  displayText: string;
  openFence?: {
    lang?: string;
  };
};

export class DiscordStreamingWriter {
  private currentMessage?: Message<boolean>;
  private logicalText = "";
  private lastEditAt = 0;
  private segments: StreamingSegment[] = [];

  constructor(
    private readonly channel: TextBasedChannel,
    private readonly config: AppConfig,
    private readonly replyTo?: Message<boolean>,
    private readonly sendState: { firstReplySent: boolean } = { firstReplySent: false },
    private readonly onFirstSend?: () => void,
  ) {}

  async append(delta: string): Promise<void> {
    this.logicalText += delta;
    if (this.logicalText.length >= this.config.streaming.hardLimitChars) {
      await this.flush(true);
      await this.rollSegment();
      return;
    }
    const now = Date.now();
    if (now - this.lastEditAt >= this.config.streaming.editIntervalMs) {
      await this.flush(false);
    }
  }

  async finish(finalText?: string): Promise<Message<boolean> | undefined> {
    if (finalText !== undefined) this.logicalText = finalText;
    await this.flush(true);
    return this.currentMessage;
  }

  async forceFlush(): Promise<void> {
    await this.flush(false);
  }

  private async flush(finalize: boolean): Promise<void> {
    if (!this.logicalText && !this.currentMessage) return;
    const displayText = finalize ? closeOpenFence(this.logicalText) : displayForEdit(this.logicalText);
    if (!this.currentMessage) {
      const replyTo = this.sendState.firstReplySent ? undefined : this.replyTo;
      this.currentMessage = await sendDiscordMessage(this.channel, displayText, replyTo ? { replyTo } : {});
      this.sendState.firstReplySent = true;
      this.segments.push({ messageId: this.currentMessage.id, logicalText: this.logicalText, displayText });
      this.onFirstSend?.();
    } else {
      await editOwnMessage(this.currentMessage, displayText || this.config.streaming.initialPlaceholder);
      const current = this.segments.at(-1);
      if (current) {
        current.logicalText = this.logicalText;
        current.displayText = displayText;
      }
    }
    this.lastEditAt = Date.now();
  }

  private async rollSegment(): Promise<void> {
    const splitAt = chooseSplit(this.logicalText, this.config.streaming.softLimitChars);
    const finished = this.logicalText.slice(0, splitAt);
    const rest = this.logicalText.slice(splitAt);
    this.logicalText = finished;
    await this.flush(true);
    this.logicalText = reopenFence(rest, detectOpenFence(finished));
    this.currentMessage = await sendDiscordMessage(this.channel, displayForEdit(this.logicalText));
    this.segments.push({ messageId: this.currentMessage.id, logicalText: this.logicalText, displayText: "" });
  }
}

function displayForEdit(text: string): string {
  return closeOpenFence(text);
}

function closeOpenFence(text: string): string {
  const fence = detectOpenFence(text);
  return fence ? `${text}\n\`\`\`` : text;
}

function detectOpenFence(text: string): { lang?: string } | undefined {
  const matches = [...text.matchAll(/```([^\n]*)/g)];
  if (matches.length % 2 === 0) return undefined;
  const lang = matches.at(-1)?.[1]?.trim();
  return lang ? { lang } : {};
}

function reopenFence(text: string, fence: { lang?: string } | undefined): string {
  if (!fence) return text;
  return `\`\`\`${fence.lang ?? ""}\n${text}`;
}
