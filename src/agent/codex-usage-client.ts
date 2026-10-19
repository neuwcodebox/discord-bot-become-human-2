import { z } from "zod";
import { readBoundedResponse } from "../storage/bounded-response.js";
import { loadCodexAccountCredentials } from "./provider.js";

const windowSchema = z
  .object({
    used_percent: z.number().nonnegative(),
    limit_window_seconds: z.number().int().positive(),
    reset_at: z.number().int().nonnegative().nullish(),
  })
  .transform((window) => ({
    remainingPercent: Math.max(0, 100 - window.used_percent),
    durationSeconds: window.limit_window_seconds,
    ...(window.reset_at != null ? { resetsAt: window.reset_at * 1000 } : {}),
  }));
const usageSchema = z
  .object({
    rate_limit: z
      .object({
        allowed: z.boolean().optional(),
        limit_reached: z.boolean().optional(),
        primary_window: windowSchema.nullish(),
        secondary_window: windowSchema.nullish(),
      })
      .nullish(),
    spend_control: z.object({ reached: z.boolean() }).nullish(),
  })
  .transform((usage, context) => {
    const windows = [usage.rate_limit?.primary_window, usage.rate_limit?.secondary_window].filter(
      (window) => window != null,
    );
    const blocked =
      usage.rate_limit?.allowed === false ||
      usage.rate_limit?.limit_reached === true ||
      usage.spend_control?.reached === true;
    if (windows.length === 0 && !blocked) {
      context.addIssue({ code: "custom", message: "No quota windows" });
      return z.NEVER;
    }
    return {
      allowed: !blocked,
      windows,
      ...(windows.length > 0
        ? { remainingPercent: Math.min(...windows.map((window) => window.remainingPercent)) }
        : {}),
    };
  });

export type CodexUsageSnapshot = z.infer<typeof usageSchema>;

/** The ordinary Codex account bucket is shared with other clients; it has no project attribution. */
export async function fetchCodexUsage(authPath: string, signal: AbortSignal): Promise<CodexUsageSnapshot> {
  try {
    const { accessToken, accountId } = await loadCodexAccountCredentials(authPath, signal);
    const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
      signal,
      redirect: "error",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "ChatGPT-Account-ID": accountId,
        originator: "discord-bot-become-human-2",
      },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Usage request failed");
    }
    const bytes = await readBoundedResponse(response, 262_144);
    return usageSchema.parse(JSON.parse(bytes.toString("utf8")));
  } catch {
    // Never propagate tokens, response bodies, or validation errors into logs or agent context.
    signal.throwIfAborted();
    throw new Error("Codex usage is unavailable. Check connectivity and npm run login:codex.");
  }
}
