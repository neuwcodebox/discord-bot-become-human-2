import { z } from "zod";
import { readBoundedResponse } from "../storage/bounded-response.js";
import { imageMimeType } from "../storage/image-format.js";

const imageOptionsSchema = z.object({
  prompt: z.string().trim().min(1).max(32_000),
  quality: z.enum(["auto", "low", "medium", "high"]).default("auto"),
  size: z.enum(["auto", "1024x1024", "1536x1024", "1024x1536"]).default("auto"),
  background: z.enum(["auto", "opaque", "transparent"]).default("auto"),
});
// HTTP payload built by the runtime; agent tools accept file paths or attachment references.
export const imagePayloadSchema = imageOptionsSchema.extend({
  images: z
    .array(z.object({ image_url: z.string().startsWith("data:image/") }))
    .min(1)
    .max(5)
    .optional(),
});
const imageResponseSchema = z.object({
  data: z.array(z.object({ b64_json: z.string().min(1) })).length(1),
});

export type ImageOptions = z.input<typeof imageOptionsSchema>;
export type ImagePayload = z.input<typeof imagePayloadSchema>;

export async function readImageResponse(
  response: Response,
  maxOutputBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const raw = await readBoundedResponse(response, 4 * Math.ceil(maxOutputBytes / 3) + 65_536);
  let encoded: string;
  try {
    const parsed = imageResponseSchema.parse(JSON.parse(raw.toString("utf8")));
    const image = parsed.data[0];
    if (!image) throw new Error("Missing image");
    encoded = image.b64_json;
  } catch {
    throw new Error("Image provider returned an invalid image response.");
  }
  if (encoded.length > 4 * Math.ceil(maxOutputBytes / 3)) {
    throw new Error("Generated image exceeds the configured byte limit.");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded)
    throw new Error("Image provider returned invalid image encoding.");
  if (bytes.length > maxOutputBytes) throw new Error("Generated image exceeds the configured byte limit.");
  if (imageMimeType(bytes) !== "image/png") throw new Error("Image provider did not return a PNG image.");
  signal.throwIfAborted();
  return bytes;
}
