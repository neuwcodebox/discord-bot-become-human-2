import type { AttachmentCache } from "../discord/attachment-cache.js";
import { fetchUrl } from "./fetch-url.js";

export type AttachmentReadResult = {
  ref: string;
  kind: string;
  filename: string;
  contentType?: string;
  text?: string;
  data?: string;
  truncated?: boolean;
  bytesRead?: number;
  limitBytes?: number;
};

export async function readAttachment(
  cache: AttachmentCache,
  input: { ref: string; maxBytes?: number },
): Promise<AttachmentReadResult> {
  const id = input.ref.replace(/^attachment:\/\//, "");
  const attachment = cache.get(id);
  if (!attachment) throw new Error(`Unknown attachment reference: ${input.ref}`);
  if (attachment.kind === "image" || attachment.kind === "sticker" || attachment.kind === "emoji") {
    const image = await fetchBinary(attachment.url, input.maxBytes ?? 2_097_152);
    return {
      ref: input.ref,
      kind: attachment.kind,
      filename: attachment.filename,
      contentType: attachment.mimeType ?? image.contentType,
      data: image.data,
      truncated: image.truncated,
      bytesRead: image.bytesRead,
      limitBytes: image.limitBytes,
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
    truncated: fetched.truncated,
    bytesRead: fetched.bytesRead,
    limitBytes: fetched.limitBytes,
  };
}

export async function readAttachmentToolContent(
  cache: AttachmentCache,
  input: { ref: string; maxBytes?: number },
) {
  const result = await readAttachment(cache, input);
  if (result.data && result.contentType) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              ref: result.ref,
              kind: result.kind,
              filename: result.filename,
              contentType: result.contentType,
              truncated: result.truncated,
            },
            null,
            2,
          ),
        },
        { type: "image" as const, data: result.data, mimeType: result.contentType },
      ],
      details: result,
    };
  }
  return {
    content: [{ type: "text" as const, text: result.text ?? JSON.stringify(result, null, 2) }],
    details: result,
  };
}

async function fetchBinary(
  url: string,
  maxBytes: number,
): Promise<{ contentType: string; data: string; truncated: boolean; bytesRead: number; limitBytes: number }> {
  const response = await fetch(url, { redirect: "follow" });
  const contentType = response.headers.get("content-type") ?? "application/octet-stream";
  const reader = response.body?.getReader();
  if (!reader) return { contentType, data: "", truncated: false, bytesRead: 0, limitBytes: maxBytes };
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      truncated = true;
      chunks.push(value.slice(0, Math.max(0, value.byteLength - (size - maxBytes))));
      break;
    }
    chunks.push(value);
  }
  return {
    contentType,
    data: Buffer.concat(chunks).toString("base64"),
    truncated,
    bytesRead: size,
    limitBytes: maxBytes,
  };
}
