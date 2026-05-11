import type { AttachmentCache } from "../discord/attachment-cache.js";
import { fetchUrl } from "./fetch-url.js";

export async function readAttachment(
  cache: AttachmentCache,
  input: { ref: string; maxBytes?: number },
): Promise<{
  ref: string;
  kind: string;
  filename: string;
  contentType?: string;
  text?: string;
  note?: string;
}> {
  const id = input.ref.replace(/^attachment:\/\//, "");
  const attachment = cache.get(id);
  if (!attachment) throw new Error(`Unknown attachment reference: ${input.ref}`);
  if (attachment.kind === "image") {
    return {
      ref: input.ref,
      kind: attachment.kind,
      filename: attachment.filename,
      ...(attachment.mimeType ? { contentType: attachment.mimeType } : {}),
      note: "Image attachment metadata is available. Provider image block support can be added by the agent runner.",
    };
  }
  const fetched = await fetchUrl({
    url: attachment.url,
    maxBytes: input.maxBytes ?? 262_144,
    allowedContentTypes: ["text/", "application/json", "application/xml", "application/yaml"],
  });
  return {
    ref: input.ref,
    kind: attachment.kind,
    filename: attachment.filename,
    ...(fetched.contentType ? { contentType: fetched.contentType } : {}),
    text: fetched.text,
  };
}
