import type { AppConfig, ConversationRuntimeState, PendingFollowUpBatch } from "../types.js";

export type FollowUpBatchConfig = AppConfig["conversation"]["engaged"]["followUpBatch"];

export function appendFollowUpMessage(input: {
  batch?: PendingFollowUpBatch | undefined;
  messageId: string;
  relatedToBot: boolean;
  now: Date;
}): PendingFollowUpBatch {
  const time = input.now.toISOString();
  if (!input.batch) {
    return {
      since: time,
      lastMessageAt: time,
      messageIds: [input.messageId],
      relatedToBot: input.relatedToBot,
      waitCount: 0,
    };
  }
  return {
    since: input.batch.since,
    lastMessageAt: time,
    messageIds: appendUnique(input.batch.messageIds, input.messageId),
    relatedToBot: input.batch.relatedToBot || input.relatedToBot,
    waitCount: 0,
  };
}

export function markFollowUpWait(batch: PendingFollowUpBatch, now: Date): PendingFollowUpBatch {
  return {
    ...batch,
    lastMessageAt: now.toISOString(),
    waitCount: batch.waitCount + 1,
  };
}

export function shouldFlushByMessageCount(batch: PendingFollowUpBatch, config: FollowUpBatchConfig): boolean {
  return batch.messageIds.length >= config.maxMessages;
}

export function computeFollowUpFlushDelayMs(input: {
  batch: PendingFollowUpBatch;
  config: FollowUpBatchConfig;
  state: Pick<ConversationRuntimeState, "cooldownUntil">;
  nowMs: number;
  debounceMs: number;
}): number {
  const maxWaitRemainingMs = Math.max(
    0,
    Date.parse(input.batch.since) + input.config.maxWaitMs - input.nowMs,
  );
  const cooldownRemainingMs =
    input.batch.relatedToBot || !input.state.cooldownUntil
      ? 0
      : Math.max(0, Date.parse(input.state.cooldownUntil) - input.nowMs);
  return Math.min(Math.max(input.debounceMs, cooldownRemainingMs), maxWaitRemainingMs);
}

function appendUnique(values: string[], next: string): string[] {
  return values.includes(next) ? values : [...values, next];
}
