import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { AttachmentCache } from "../discord/attachment-cache.js";
import { assertInsideWorkspace } from "../paths/workspace-guard.js";
import { readBoundedResponse } from "../storage/bounded-response.js";
import { imageMimeType } from "../storage/image-format.js";
import type { ToolContext } from "../types.js";

/** Resolve guild-scoped references into data URLs for the runtime's image API request. */
export async function loadImageInputs(options: {
  context: ToolContext;
  references: readonly string[];
  attachments: AttachmentCache | undefined;
  maxBytes: number;
  signal: AbortSignal;
}): Promise<string[]> {
  const { context, references, attachments, signal } = options;
  const images: string[] = [];
  let remainingBytes = options.maxBytes;
  for (const reference of references) {
    signal.throwIfAborted();
    const bytes = await readInputImage(context, reference, attachments, remainingBytes, signal);
    remainingBytes -= bytes.length;
    const mimeType = imageMimeType(bytes);
    if (!mimeType) throw new Error("Image input must contain PNG, JPEG, or WebP image data.");
    images.push(`data:${mimeType};base64,${bytes.toString("base64")}`);
  }
  return images;
}

async function readInputImage(
  context: ToolContext,
  reference: string,
  attachments: AttachmentCache | undefined,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  if (maxBytes <= 0) throw new Error("Image inputs exceed the configured total byte limit.");
  if (reference.startsWith("attachment://")) {
    return readImageAttachment(context, reference, attachments, maxBytes, signal);
  }
  if (isAbsolute(reference) || /^[a-z][a-z0-9+.-]*:/i.test(reference)) {
    throw new Error("Image inputs must be workspace-relative paths or attachment:// references.");
  }
  const path = await assertInsideWorkspace(context.workspaceRoot, reference);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error("Image input must be a regular file.");
    if (info.size > maxBytes) throw new Error("Image inputs exceed the configured total byte limit.");
    const chunks: Buffer[] = [];
    let size = 0;
    while (true) {
      signal.throwIfAborted();
      const chunk = Buffer.alloc(Math.min(65_536, maxBytes - size + 1));
      const { bytesRead } = await file.read(chunk);
      if (!bytesRead) return Buffer.concat(chunks);
      size += bytesRead;
      if (size > maxBytes) throw new Error("Image inputs exceed the configured total byte limit.");
      chunks.push(chunk.subarray(0, bytesRead));
    }
  } finally {
    await file.close();
  }
}

async function readImageAttachment(
  context: ToolContext,
  reference: string,
  attachments: AttachmentCache | undefined,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const attachment = attachments?.getForGuild(reference.slice("attachment://".length), context.guildId);
  if (!attachment || !["image", "sticker", "emoji"].includes(attachment.kind)) {
    throw new Error("Unknown image attachment in the current guild.");
  }
  if (attachment.size !== undefined && attachment.size > maxBytes) {
    throw new Error("Image inputs exceed the configured total byte limit.");
  }
  const url = new URL(attachment.url);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !["cdn.discordapp.com", "media.discordapp.net"].includes(url.hostname)
  ) {
    throw new Error("Image attachments must use the Discord CDN.");
  }
  let response: Response;
  try {
    response = await fetch(url, { signal, redirect: "error" });
  } catch {
    signal.throwIfAborted();
    throw new Error("Image attachment download failed.");
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Image attachment download failed (HTTP ${response.status}).`);
  }
  return readBoundedResponse(response, maxBytes);
}
