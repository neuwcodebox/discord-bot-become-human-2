import type { Message, TextBasedChannel } from "discord.js";
import type { AppConfig } from "../types.js";
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
  ) {}

  async start(): Promise<void> {
    this.currentMessage = await sendDiscordMessage(
      this.channel,
      this.config.streaming.initialPlaceholder,
      this.replyTo ? { replyTo: this.replyTo } : {},
    );
    this.segments.push({ messageId: this.currentMessage.id, logicalText: "", displayText: "" });
  }

  async append(delta: string): Promise<void> {
    if (!this.currentMessage) await this.start();
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

  private async flush(finalize: boolean): Promise<void> {
    if (!this.currentMessage) return;
    const displayText = finalize ? closeOpenFence(this.logicalText) : displayForEdit(this.logicalText);
    await editOwnMessage(this.currentMessage, displayText || this.config.streaming.initialPlaceholder);
    this.lastEditAt = Date.now();
    const current = this.segments.at(-1);
    if (current) {
      current.logicalText = this.logicalText;
      current.displayText = displayText;
    }
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

function chooseSplit(text: string, softLimit: number): number {
  const candidates = ["\n\n", "\n", ". ", " "];
  for (const sep of candidates) {
    const index = text.lastIndexOf(sep, softLimit);
    if (index > 0) return index + sep.length;
  }
  return softLimit;
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
