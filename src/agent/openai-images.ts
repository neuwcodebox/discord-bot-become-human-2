import type { OpenAICompatLlmConfig } from "../config.js";
import { childLogger } from "../logger.js";
import { type ImagePayload, imagePayloadSchema, readImageResponse } from "./image-response.js";

const log = childLogger("openai-images");

/** Chat-completions compatibility does not imply Images API support. */
export function supportsOpenAIImages(llm: OpenAICompatLlmConfig): boolean {
  return /^https:\/\/api\.openai\.com\/v1\/?$/.test(llm.baseURL);
}

export async function requestOpenAIImage(
  llm: OpenAICompatLlmConfig,
  model: string,
  input: ImagePayload,
  maxOutputBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  signal.throwIfAborted();
  if (!supportsOpenAIImages(llm)) throw new Error("Image tools require the official OpenAI API endpoint.");
  const apiKey = process.env[llm.apiKeyEnv]?.trim();
  if (!apiKey)
    throw new Error("OpenAI image API key is missing. Check the configured API key environment variable.");
  const request = imagePayloadSchema.parse(input);
  if (request.images?.some((image) => image.image_url.length > 20_971_520)) {
    throw new Error("OpenAI edit input exceeds the API data URL limit. Use a smaller image.");
  }
  const operation = request.images ? "edits" : "generations";
  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetch(`https://api.openai.com/v1/images/${operation}`, {
      method: "POST",
      redirect: "error",
      signal,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ...request, model, n: 1, output_format: "png" }),
    });
  } catch {
    signal.throwIfAborted();
    throw new Error("OpenAI image network request failed. No automatic retry was attempted.");
  }
  log.info(
    { operation, status: response.status, durationMs: Date.now() - startedAt },
    "image request completed",
  );
  if (!response.ok) {
    await response.body?.cancel();
    const hint =
      response.status === 401
        ? "Check the configured OpenAI API key."
        : response.status === 403
          ? "Check API project model access and organization verification."
          : response.status === 429
            ? "OpenAI API quota or rate limit reached; check billing or retry later."
            : "Check image inputs and model availability before retrying.";
    // Error bodies may echo private prompts or credentials; expose only status and safe guidance.
    throw new Error(`OpenAI image request failed (HTTP ${response.status}). ${hint}`);
  }
  return readImageResponse(response, maxOutputBytes, signal);
}
