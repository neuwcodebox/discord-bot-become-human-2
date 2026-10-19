import { randomUUID } from "node:crypto";
import { z } from "zod";
import { childLogger } from "../logger.js";
import { readBoundedResponse } from "../storage/bounded-response.js";
import { imageMimeType } from "../storage/image-format.js";
import { loadCodexAccountCredentials } from "./provider.js";

const log = childLogger("codex-images");
const imageOptionsSchema = z.object({
  prompt: z.string().trim().min(1).max(32_000),
  quality: z.enum(["auto", "low", "medium", "high"]).default("auto"),
  size: z.enum(["auto", "1024x1024", "1536x1024", "1024x1536"]).default("auto"),
  background: z.enum(["auto", "opaque", "transparent"]).default("auto"),
});
// HTTP payload built by the runtime; agent tools accept file paths or attachment references.
const codexImagePayloadSchema = imageOptionsSchema.extend({
  images: z
    .array(z.object({ image_url: z.string().startsWith("data:image/") }))
    .min(1)
    .max(5)
    .optional(),
});
const imageResponseSchema = z.object({
  data: z.array(z.object({ b64_json: z.string().min(1) })).length(1),
});

export type CodexImageOptions = z.input<typeof imageOptionsSchema>;
type CodexImagePayload = z.input<typeof codexImagePayloadSchema>;

/** Uses the same ChatGPT OAuth provider/auth and JSON Images API as the official Codex client. */
export async function requestCodexImage(
  authPath: string,
  input: CodexImagePayload,
  maxOutputBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  signal.throwIfAborted();
  const request = codexImagePayloadSchema.parse(input);
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
  const raw = await readBoundedResponse(response, 4 * Math.ceil(maxOutputBytes / 3) + 65_536);
  let encoded: string;
  try {
    const parsed = imageResponseSchema.parse(JSON.parse(raw.toString("utf8")));
    const image = parsed.data[0];
    if (!image) throw new Error("Missing image");
    encoded = image.b64_json;
  } catch {
    throw new Error("Codex returned an invalid image response.");
  }
  if (encoded.length > 4 * Math.ceil(maxOutputBytes / 3)) {
    throw new Error("Generated image exceeds the configured byte limit.");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) throw new Error("Codex returned invalid image encoding.");
  if (bytes.length > maxOutputBytes) throw new Error("Generated image exceeds the configured byte limit.");
  if (imageMimeType(bytes) !== "image/png") throw new Error("Codex did not return a PNG image.");
  signal.throwIfAborted();
  return bytes;
}
