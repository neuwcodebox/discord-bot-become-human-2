import { afterEach, describe, expect, it, vi } from "vitest";
import { FetchUrlResponseError, fetchUrl } from "../src/tools/fetch-url.js";

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

  it("includes response details when the HTTP status is not ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("not found details", {
            status: 404,
            statusText: "Not Found",
            headers: { "content-type": "text/plain" },
          }),
      ),
    );

    try {
      await fetchUrl({ url: "https://example.com/missing.txt" });
      throw new Error("expected fetchUrl to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(FetchUrlResponseError);
      if (!(error instanceof FetchUrlResponseError)) throw error;
      expect(error.message).toContain("HTTP request failed: 404 Not Found");
      expect(error.message).toContain("contentType=text/plain");
      expect(error.message).toContain('bodyPreview="not found details"');
      expect(error.status).toBe(404);
      expect(error.bodyText).toBe("not found details");
      expect(error.bodyTruncated).toBe(false);
    }
  });

  it("truncates response body details for HTTP errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("abcdefghij", {
            status: 500,
            statusText: "Internal Server Error",
            headers: { "content-type": "text/plain" },
          }),
      ),
    );

    try {
      await fetchUrl({ url: "https://example.com/error.txt", maxErrorBodyBytes: 4 });
      throw new Error("expected fetchUrl to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(FetchUrlResponseError);
      if (!(error instanceof FetchUrlResponseError)) throw error;
      expect(error.bodyText).toBe("abcd");
      expect(error.bodyTruncated).toBe(true);
      expect(error.limitBytes).toBe(4);
      expect(error.message).toContain("truncated at 4 bytes");
    }
  });

  it("reports truncation metadata when text exceeds max bytes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("abcdefghij", {
            headers: { "content-type": "text/plain" },
          }),
      ),
    );

    const result = await fetchUrl({ url: "https://example.com/large.txt", maxBytes: 4 });

    expect(result.truncated).toBe(true);
    expect(result.bytesRead).toBeGreaterThan(result.limitBytes);
    expect(result.limitBytes).toBe(4);
  });
});
