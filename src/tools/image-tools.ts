import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, unlink } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { type CodexImageOptions, requestCodexImage } from "../agent/codex-images.js";
import type { CodexLlmConfig } from "../config.js";
import type { AttachmentCache } from "../discord/attachment-cache.js";
import { assertInsideWorkspace } from "../paths/workspace-guard.js";
import type { AppConfig, RuntimeAgentTool, ToolContext } from "../types.js";
import { loadImageInputs } from "./image-input.js";
import { defineTool, jsonResult } from "./tool-definition.js";

const optionProperties = {
  prompt: Type.String({ minLength: 1, maxLength: 32_000 }),
  quality: Type.Optional(
    Type.Union([Type.Literal("auto"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
  ),
  size: Type.Optional(
    Type.Union([
      Type.Literal("auto"),
      Type.Literal("1024x1024"),
      Type.Literal("1536x1024"),
      Type.Literal("1024x1536"),
    ]),
  ),
  background: Type.Optional(
    Type.Union([Type.Literal("auto"), Type.Literal("opaque"), Type.Literal("transparent")]),
  ),
};

export function createImageTools(
  llm: CodexLlmConfig,
  limits: AppConfig["images"],
  context: ToolContext,
  attachments?: AttachmentCache,
): RuntimeAgentTool[] {
  return [
    defineTool({
      name: "generate_image",
      label: "Generate Image",
      description:
        "Generate one PNG from a conversation image request. Returns a new workspace-relative file path. Attach the file with discord_send_message(files: [path]) and keep its path out of Discord text. Do not retry automatically after failure.",
      parameters: Type.Object(optionProperties),
      execute: async (_id, params, signal) =>
        jsonResult(await runImageRequest(llm, limits, context, params, undefined, attachments, signal)),
    }),
    defineTool({
      name: "edit_image",
      label: "Edit Image",
      description:
        "Edit or combine 1–5 images following the prompt. images must be current-guild attachment:// references or workspace-relative PNG/JPEG/WebP file paths (including earlier generated images). Returns a new PNG workspace path without overwriting inputs. Attach the file with discord_send_message(files: [path]) and keep its path out of Discord text. Do not retry automatically after failure.",
      parameters: Type.Object({
        ...optionProperties,
        images: Type.Array(
          Type.String({
            minLength: 1,
            description: "Workspace-relative image file path or current-guild attachment:// reference.",
          }),
          { minItems: 1, maxItems: 5 },
        ),
      }),
      execute: async (_id, { images, ...params }, signal) => {
        if (!images || images.length < 1 || images.length > 5) {
          throw new Error("Image editing requires 1–5 input images.");
        }
        return jsonResult(await runImageRequest(llm, limits, context, params, images, attachments, signal));
      },
    }),
  ];
}

async function runImageRequest(
  llm: CodexLlmConfig,
  limits: AppConfig["images"],
  context: ToolContext,
  input: CodexImageOptions,
  references: string[] | undefined,
  attachments: AttachmentCache | undefined,
  externalSignal: AbortSignal | undefined,
): Promise<{ path: string; mimeType: string; bytes: number }> {
  const timeout = AbortSignal.timeout(limits.timeoutMs);
  const signal = externalSignal ? AbortSignal.any([externalSignal, timeout]) : timeout;
  signal.throwIfAborted();
  const images = await loadImageInputs({
    context,
    references: references ?? [],
    attachments,
    maxBytes: limits.maxInputBytes,
    signal,
  });
  // Check output directory confinement before consuming plan usage, including existing symlinks.
  const root = await assertInsideWorkspace(context.workspaceRoot, ".");
  const path = await assertInsideWorkspace(root, `generated/images/${randomUUID()}.png`);
  await mkdir(dirname(path), { recursive: true });
  await assertInsideWorkspace(root, path);
  signal.throwIfAborted();
  const bytes = await requestCodexImage(
    llm.codex.authPath,
    {
      prompt: input.prompt,
      ...(input.quality !== undefined ? { quality: input.quality } : {}),
      ...(input.size !== undefined ? { size: input.size } : {}),
      ...(input.background !== undefined ? { background: input.background } : {}),
      ...(references ? { images: images.map((image_url) => ({ image_url })) } : {}),
    },
    limits.maxOutputBytes,
    signal,
  );
  await assertInsideWorkspace(root, path);
  signal.throwIfAborted();
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    await file.writeFile(bytes, { signal });
    signal.throwIfAborted();
  } catch (error) {
    await unlink(path);
    throw error;
  } finally {
    await file.close();
  }
  return { path: relative(root, path), mimeType: "image/png", bytes: bytes.length };
}
