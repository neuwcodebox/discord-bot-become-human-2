import { mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defaultConfig } from "../src/config.js";
import { AttachmentCache } from "../src/discord/attachment-cache.js";
import { createToolRegistry } from "../src/tools/tool-registry.js";
import type { AppConfig, RuntimeAgentTool } from "../src/types.js";
import { createMessage } from "./helpers/conversation.js";
import { createTestWorkspace } from "./helpers/workspace.js";

// A real 1x1 PNG, rather than just a matching filename or content-type header.
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1sAAAAASUVORK5CYII=",
  "base64",
);
const imageResultSchema = z.object({ path: z.string(), mimeType: z.literal("image/png"), bytes: z.number() });

function token(): string {
  const payload = { "https://api.openai.com/auth": { chatgpt_account_id: "account-1" } };
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

function imageResponse(): Response {
  return Response.json({ created: 1, data: [{ b64_json: png.toString("base64") }] });
}

async function setup(limits: Partial<AppConfig["images"]> = {}) {
  const runtimeRoot = await createTestWorkspace("dbh2-images-");
  const workspaceRoot = join(runtimeRoot, "workspace");
  await mkdir(workspaceRoot);
  const authPath = join(runtimeRoot, "codex-auth.json");
  await writeFile(authPath, JSON.stringify({ access_token: token() }));
  if (defaultConfig.llm.provider !== "openai-codex") throw new Error("Expected Codex default provider");
  const config = {
    ...defaultConfig,
    llm: { ...defaultConfig.llm, codex: { ...defaultConfig.llm.codex, authPath } },
    images: { ...defaultConfig.images, ...limits },
  };
  const cache = new AttachmentCache();
  const tools = createToolRegistry(config, { guildId: "g1", workspaceRoot }, { attachmentCache: cache });
  const generate = tools.find((tool) => tool.name === "generate_image");
  const edit = tools.find((tool) => tool.name === "edit_image");
  if (!generate || !edit) throw new Error("Missing image tools");
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => imageResponse());
  vi.stubGlobal("fetch", fetchMock);
  return { runtimeRoot, workspaceRoot, authPath, config, cache, generate, edit, fetchMock };
}

async function executeImage(tool: RuntimeAgentTool, params: unknown, signal?: AbortSignal) {
  const result = await tool.execute("image-call", params, signal);
  const content = result.content[0];
  if (content?.type !== "text") throw new Error("Expected metadata tool result");
  return { metadata: imageResultSchema.parse(JSON.parse(content.text)), result };
}

function rememberImage(
  cache: AttachmentCache,
  guildId = "g1",
  url = "https://cdn.discordapp.com/attachments/image.png",
) {
  cache.remember(
    createMessage("m1", {
      guildId,
      attachments: [{ id: "a1", filename: "image.png", kind: "image", url, size: png.length }],
    }),
  );
}

async function savedImages(root: string): Promise<string[]> {
  return readdir(join(root, "generated/images")).catch(() => []);
}

describe("Codex OAuth image tools", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("generates a new PNG using configured OAuth only and returns metadata without image data", async () => {
    const { generate, fetchMock, workspaceRoot } = await setup();
    vi.stubEnv("OPENAI_API_KEY", "must-not-use-this-api-key");
    const { metadata, result } = await executeImage(generate, {
      prompt: "a blue whale",
      quality: "low",
      size: "1024x1024",
      background: "transparent",
    });
    expect(metadata).toEqual({
      path: expect.stringMatching(/^generated\/images\/[\w-]+\.png$/),
      mimeType: "image/png",
      bytes: png.length,
    });
    expect(await readFile(join(workspaceRoot, metadata.path))).toEqual(png);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://chatgpt.com/backend-api/codex/images/generations");
    expect(init).toMatchObject({
      method: "POST",
      redirect: "error",
      headers: { Authorization: `Bearer ${token()}`, "ChatGPT-Account-ID": "account-1" },
    });
    expect(init?.body).toBe(
      JSON.stringify({
        prompt: "a blue whale",
        quality: "low",
        size: "1024x1024",
        background: "transparent",
        model: "gpt-image-2",
        n: 1,
      }),
    );
    expect(JSON.stringify(result)).not.toContain(png.toString("base64"));
    expect(JSON.stringify(result)).not.toContain(token());
  });

  it("edits workspace images and current-guild attachments using JSON data URLs and preserves the original", async () => {
    const { edit, cache, workspaceRoot, fetchMock } = await setup();
    await writeFile(join(workspaceRoot, "original.png"), png);
    rememberImage(cache);
    fetchMock.mockImplementation(async (url) => (url instanceof URL ? new Response(png) : imageResponse()));
    const { metadata } = await executeImage(edit, {
      prompt: "combine these images",
      images: ["original.png", "attachment://a1"],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      redirect: "error",
      signal: expect.any(AbortSignal),
    });
    const [url, init] = fetchMock.mock.calls[1] ?? [];
    expect(url).toBe("https://chatgpt.com/backend-api/codex/images/edits");
    const body = z
      .object({ images: z.array(z.object({ image_url: z.string() })) })
      .parse(JSON.parse(String(init?.body)));
    expect(body.images).toEqual(
      Array.from({ length: 2 }, () => ({ image_url: `data:image/png;base64,${png.toString("base64")}` })),
    );
    expect(await readFile(join(workspaceRoot, "original.png"))).toEqual(png);
    expect(metadata.path).not.toBe("original.png");
    const followUp = await executeImage(edit, { prompt: "make it warmer", images: [metadata.path] });
    expect(followUp.metadata.path).not.toBe(metadata.path);
  });

  it("accepts JPEG and WebP inputs based on bytes rather than filename or headers", async () => {
    const { edit, workspaceRoot, fetchMock } = await setup();
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    const webp = Buffer.from("RIFF0000WEBPpayload");
    await writeFile(join(workspaceRoot, "jpeg.bin"), jpeg);
    await writeFile(join(workspaceRoot, "webp.bin"), webp);
    await executeImage(edit, { prompt: "combine", images: ["jpeg.bin", "webp.bin"] });
    const body = String(fetchMock.mock.calls[0]?.[1]?.body);
    expect(body).toContain("data:image/jpeg;base64,");
    expect(body).toContain("data:image/webp;base64,");
  });

  it.each(["g2", "missing"])(
    "rejects other-guild or missing attachments before downloading (%s)",
    async (guild) => {
      const { edit, cache, fetchMock } = await setup();
      if (guild !== "missing") rememberImage(cache, guild);
      await expect(edit.execute("call", { prompt: "edit", images: ["attachment://a1"] })).rejects.toThrow(
        /current guild/,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    "../codex-auth.json",
    "/etc/passwd",
    "https://example.com/a.png",
    "file:///etc/passwd",
    `data:image/png;base64,${png.toString("base64")}`,
  ])("rejects external image references: %s", async (reference) => {
    const { edit, fetchMock } = await setup();
    await expect(edit.execute("call", { prompt: "edit", images: [reference] })).rejects.toThrow(/workspace/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects input symlinks outside the workspace and output symlinks before creating outside directories or calling the API", async () => {
    const { generate, edit, fetchMock, runtimeRoot, workspaceRoot } = await setup();
    await symlink(join(runtimeRoot, "codex-auth.json"), join(workspaceRoot, "input.png"));
    await expect(edit.execute("call", { prompt: "edit", images: ["input.png"] })).rejects.toThrow(/escapes/);
    const outside = await createTestWorkspace("dbh2-images-outside-");
    await symlink(outside, join(workspaceRoot, "generated"));
    await expect(generate.execute("call", { prompt: "whale" })).rejects.toThrow(/escapes/);
    expect(await readdir(outside)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects non-image content before sending it to the provider", async () => {
    const { edit, workspaceRoot, fetchMock } = await setup();
    await writeFile(join(workspaceRoot, "fake.png"), "private text");
    await expect(edit.execute("call", { prompt: "edit", images: ["fake.png"] })).rejects.toThrow(
      /image data/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rechecks output confinement after a long provider request", async () => {
    const { generate, workspaceRoot, fetchMock } = await setup();
    const outside = await createTestWorkspace("dbh2-images-outside-");
    fetchMock.mockImplementation(async () => {
      await rm(join(workspaceRoot, "generated"), { recursive: true });
      await symlink(outside, join(workspaceRoot, "generated"));
      return imageResponse();
    });
    await expect(generate.execute("call", { prompt: "whale" })).rejects.toThrow(/escapes/);
    expect(await readdir(outside)).toEqual([]);
  });

  it("does not forward hidden extra parameters as provider input", async () => {
    const { generate, fetchMock } = await setup();
    await executeImage(generate, {
      prompt: "whale",
      images: [{ image_url: "data:image/png;base64,hidden" }],
      model: "unexpected",
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://chatgpt.com/backend-api/codex/images/generations");
    const body = String(fetchMock.mock.calls[0]?.[1]?.body);
    expect(body).not.toContain("hidden");
    expect(body).not.toContain("unexpected");
  });

  it("enforces a total input byte budget across all images", async () => {
    const { edit, workspaceRoot, fetchMock } = await setup({ maxInputBytes: png.length });
    await writeFile(join(workspaceRoot, "input.png"), png);
    await expect(
      edit.execute("call", { prompt: "edit", images: ["input.png", "input.png"] }),
    ).rejects.toThrow(/total byte limit/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([{ images: [] }, { images: Array.from({ length: 6 }, () => "input.png") }])(
    "rejects invalid image counts before API requests",
    async ({ images }) => {
      const { edit, fetchMock } = await setup();
      await expect(edit.execute("call", { prompt: "edit", images })).rejects.toThrow(/1–5/);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("rejects attachments outside Discord CDN without fetching", async () => {
    const { edit, cache, fetchMock } = await setup();
    rememberImage(cache, "g1", "http://127.0.0.1/secret");
    await expect(edit.execute("call", { prompt: "edit", images: ["attachment://a1"] })).rejects.toThrow(
      /Discord CDN/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cancels oversized attachment streams instead of using truncated image data", async () => {
    const { edit, cache, fetchMock } = await setup({ maxInputBytes: png.length });
    rememberImage(cache);
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.alloc(png.length + 1));
      },
      cancel,
    });
    fetchMock.mockResolvedValue(new Response(stream));
    await expect(edit.execute("call", { prompt: "edit", images: ["attachment://a1"] })).rejects.toThrow(
      /byte limit/,
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403, 429, 500])(
    "reports HTTP %s without echoing provider bodies or retrying",
    async (status) => {
      const { generate, fetchMock, workspaceRoot } = await setup();
      fetchMock.mockResolvedValue(new Response(`private prompt ${token()}`, { status }));
      let failure: unknown;
      try {
        await generate.execute("call", { prompt: "private prompt" });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).toContain(`HTTP ${status}`);
      expect(String(failure)).not.toContain("private prompt");
      expect(String(failure)).not.toContain(token());
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(await savedImages(workspaceRoot)).toEqual([]);
    },
  );

  it.each([
    { data: [] },
    { data: [{ url: "https://example.com/secret" }] },
    { data: [{ b64_json: "!!!" }] },
    { data: [{ b64_json: Buffer.from("not an image").toString("base64") }] },
  ])("does not persist malformed image responses", async (body) => {
    const { generate, fetchMock, workspaceRoot } = await setup();
    fetchMock.mockResolvedValue(Response.json(body));
    await expect(generate.execute("call", { prompt: "whale" })).rejects.toThrow(/Codex/);
    expect(await savedImages(workspaceRoot)).toEqual([]);
  });

  it("enforces decoded output size even when the response is small enough to parse", async () => {
    const { generate, workspaceRoot } = await setup({ maxOutputBytes: png.length - 1 });
    await expect(generate.execute("call", { prompt: "whale" })).rejects.toThrow(/byte limit/);
    expect(await savedImages(workspaceRoot)).toEqual([]);
  });

  it("cancels output streams that exceed the response budget", async () => {
    const { generate, fetchMock, workspaceRoot } = await setup({ maxOutputBytes: 10 });
    const cancel = vi.fn();
    fetchMock.mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Buffer.alloc(70_000));
          },
          cancel,
        }),
      ),
    );
    await expect(generate.execute("call", { prompt: "whale" })).rejects.toThrow(/byte limit/);
    expect(cancel).toHaveBeenCalledOnce();
    expect(await savedImages(workspaceRoot)).toEqual([]);
  });

  it("does not start work with an already aborted signal", async () => {
    const { generate, fetchMock } = await setup();
    await expect(generate.execute("call", { prompt: "whale" }, AbortSignal.abort())).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("aborts an in-flight generation and does not save or retry it", async () => {
    const { generate, fetchMock, workspaceRoot } = await setup();
    const controller = new AbortController();
    fetchMock.mockImplementation(async (_url, init) => {
      controller.abort();
      init?.signal?.throwIfAborted();
      return imageResponse();
    });
    await expect(generate.execute("call", { prompt: "whale" }, controller.signal)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await savedImages(workspaceRoot)).toEqual([]);
  });

  it("times out a pending request and forwards the timeout signal to fetch", async () => {
    const { generate, fetchMock, workspaceRoot } = await setup({ timeoutMs: 40 });
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        }),
    );
    await expect(generate.execute("call", { prompt: "whale" })).rejects.toThrow(/timeout/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await savedImages(workspaceRoot)).toEqual([]);
  });

  it("reports missing OAuth without reading unrelated API credentials or contacting the provider", async () => {
    const { generate, authPath, fetchMock } = await setup();
    await writeFile(authPath, JSON.stringify({ access_token: "private-invalid-token" }));
    await expect(generate.execute("call", { prompt: "whale" })).rejects.toThrow(/login:codex/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
