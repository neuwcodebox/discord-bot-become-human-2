import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchUrl } from "../src/tools/fetch-url.js";

describe("fetch url tool", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects binary content types by default", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }),
      ),
    );

    await expect(fetchUrl({ url: "https://example.com/image.png" })).rejects.toThrow(
      /Unsupported content-type/,
    );
  });
});
