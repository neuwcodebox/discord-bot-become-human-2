import { randomUUID } from "node:crypto";
import { childLogger } from "../logger.js";
import { type ImagePayload, imagePayloadSchema, readImageResponse } from "./image-response.js";
import { loadCodexAccountCredentials } from "./provider.js";

export type { ImageOptions as CodexImageOptions } from "./image-response.js";

const log = childLogger("codex-images");
/** Uses the same ChatGPT OAuth provider/auth and JSON Images API as the official Codex client. */
export async function requestCodexImage(
  authPath: string,
  input: ImagePayload,
  maxOutputBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  signal.throwIfAborted();
  const request = imagePayloadSchema.parse(input);
  const { accessToken, accountId } = await loadCodexAccountCredentials(authPath, signal);
  signal.throwIfAborted();
  const operation = request.images ? "edits" : "generations";
  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetch(`https://chatgpt.com/backend-api/codex/images/${operation}`, {
      method: "POST",
      redirect: "error",
      signal,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "ChatGPT-Account-ID": accountId,
        "Content-Type": "application/json",
        originator: "discord-bot-become-human-2",
        "x-codex-image-turn-id": randomUUID(),
      },
      body: JSON.stringify({ ...request, model: "gpt-image-2", n: 1 }),
    });
  } catch {
    signal.throwIfAborted();
    throw new Error("Codex image network request failed. No automatic retry was attempted.");
  }
  log.info(
    { operation, status: response.status, durationMs: Date.now() - startedAt },
    "image request completed",
  );
  if (!response.ok) {
    await response.body?.cancel();
    const hint =
      response.status === 401
        ? "Run: npm run login:codex"
        : response.status === 403
          ? "Image generation is unavailable for this ChatGPT account or workspace."
          : response.status === 429
            ? "ChatGPT usage or rate limit reached; retry later."
            : "Check image inputs and account availability before retrying.";
    // Provider error bodies may echo prompts, inputs, or auth details. Never expose them.
    throw new Error(`Codex image request failed (HTTP ${response.status}). ${hint}`);
  }
  return readImageResponse(response, maxOutputBytes, signal);
}
