import { afterEach, describe, expect, it, vi } from "vitest";
import { AttachmentCache } from "../src/discord/attachment-cache.js";
import { readAttachmentToolContent } from "../src/tools/attachment.js";

describe("attachment tool", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns provider image content for image attachments", async () => {
    const cache = new AttachmentCache();
    cache.remember({
      id: "m1",
      guildId: "g",
      channelId: "c",
      author: { id: "u", username: "u", displayName: "u", isBot: false },
      content: "",
      cleanContent: "",
      createdAt: "2026-05-10T12:00:00.000Z",
      mentions: [],
      attachments: [
        {
          id: "a1",
          url: "https://cdn.example/image.png",
          filename: "image.png",
          mimeType: "image/png",
          size: 4,
          kind: "image",
        },
      ],
      embeds: [],
      reactions: [],
      links: [],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(new Uint8Array([1, 2, 3, 4]), { headers: { "content-type": "image/png" } }),
      ),
    );

    const result = await readAttachmentToolContent(cache, { ref: "attachment://a1" });

    expect(result.content).toEqual([
      {
        type: "text",
        text: expect.stringContaining("image.png"),
      },
      {
        type: "image",
        data: Buffer.from([1, 2, 3, 4]).toString("base64"),
        mimeType: "image/png",
      },
    ]);
  });

  it("reports truncation metadata for attachment reads", async () => {
    const cache = new AttachmentCache();
    cache.remember({
      id: "m1",
      guildId: "g",
      channelId: "c",
      author: { id: "u", username: "u", displayName: "u", isBot: false },
      content: "",
      cleanContent: "",
      createdAt: "2026-05-10T12:00:00.000Z",
      mentions: [],
      attachments: [
        {
          id: "a1",
          url: "https://cdn.example/log.txt",
          filename: "log.txt",
          mimeType: "text/plain",
          size: 10,
          kind: "file",
        },
      ],
      embeds: [],
      reactions: [],
      links: [],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("abcdefghij", { headers: { "content-type": "text/plain" } })),
    );

    const result = await readAttachmentToolContent(cache, { ref: "attachment://a1", maxBytes: 4 });

    expect(result.details.truncated).toBe(true);
    expect(result.details.limitBytes).toBe(4);
  });
});
