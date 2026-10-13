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
  private currentMessage: Message<boolean> | undefined;
  private logicalText = "";
  private lastEditAt = 0;
  private segments: StreamingSegment[] = [];
  private committedChars = 0;
  private prefix = "";
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly channel: TextBasedChannel,
    private readonly config: AppConfig,
    private readonly replyTo?: Message<boolean>,
    private readonly sendState: { firstReplySent: boolean } = { firstReplySent: false },
    private readonly onFirstSend?: () => void,
    private readonly signal?: AbortSignal,
  ) {}

  get lastMessageId(): string | undefined {
    return this.currentMessage?.id ?? this.segments.at(-1)?.messageId;
  }

  startMessage(): Promise<void> {
    return this.enqueue(async () => {
      if (this.logicalText) await this.flush(true);
      this.currentMessage = undefined;
      this.logicalText = "";
      this.committedChars = 0;
      this.prefix = "";
    });
  }

  append(delta: string): Promise<void> {
    return this.enqueue(() => this.appendNow(delta));
  }

  private async appendNow(delta: string): Promise<void> {
    this.logicalText += delta;
    while (displayForEdit(this.logicalText).length > this.config.streaming.hardLimitChars) {
      await this.rollSegment();
    }
    const now = Date.now();
    if (now - this.lastEditAt >= this.config.streaming.editIntervalMs) {
      await this.flush(false);
    }
  }

  async finish(finalText?: string): Promise<Message<boolean> | undefined> {
    await this.enqueue(async () => {
      if (finalText !== undefined) this.logicalText = this.prefix + finalText.slice(this.committedChars);
      while (displayForEdit(this.logicalText).length > this.config.streaming.hardLimitChars)
        await this.rollSegment();
      await this.flush(true);
    });
    return this.currentMessage;
  }

  async forceFlush(): Promise<void> {
    await this.enqueue(() => this.flush(false));
  }

  private enqueue(write: () => Promise<void>): Promise<void> {
    const next = this.writes.then(() => {
      this.signal?.throwIfAborted();
      return write();
    });
    this.writes = next.catch(() => {});
    return next;
  }

  private async flush(finalize: boolean): Promise<void> {
    this.signal?.throwIfAborted();
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
    const limit = Math.max(
      1,
      Math.min(this.config.streaming.softLimitChars, this.config.streaming.hardLimitChars - 4),
    );
    const requestedSplit = Math.min(chooseSplit(this.logicalText, limit), limit);
    // Reopening a fence is presentation overhead; every segment must consume original text.
    const splitAt = Math.min(this.logicalText.length, Math.max(requestedSplit, this.prefix.length + 1));
    const finished = this.logicalText.slice(0, splitAt);
    const rest = this.logicalText.slice(splitAt);
    this.logicalText = finished;
    await this.flush(true);
    this.signal?.throwIfAborted();
    this.committedChars += finished.length - this.prefix.length;
    this.logicalText = reopenFence(rest, detectOpenFence(finished), limit - 1);
    this.prefix = this.logicalText.slice(0, this.logicalText.length - rest.length);
    this.currentMessage = undefined;
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
  return lang && /^[\w+.#-]{1,32}$/.test(lang) ? { lang } : {};
}

function reopenFence(text: string, fence: { lang?: string } | undefined, maxPrefixChars: number): string {
  if (!fence) return text;
  const prefix = `\`\`\`${fence.lang ?? ""}\n`;
  if (prefix.length <= maxPrefixChars) return prefix + text;
  return maxPrefixChars >= 4 ? `\`\`\`\n${text}` : text;
}
