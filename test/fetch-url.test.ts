import { afterEach, describe, expect, it, vi } from "vitest";
import { FetchUrlResponseError, fetchUrl } from "../src/tools/fetch-url.js";

describe("fetch url tool", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects binary content types by default", async () => {
    stubFetch(new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }));

    await expect(fetchUrl({ url: "https://example.com/image.png" })).rejects.toMatchObject({
      name: "FetchUrlResponseError",
      contentType: "image/png",
      bodyText: "",
    });
  });

  it("includes response details when the HTTP status is not ok", async () => {
    stubFetch(
      new Response("not found details", {
        status: 404,
        statusText: "Not Found",
        headers: { "content-type": "text/plain" },
      }),
    );

    const request = fetchUrl({ url: "https://example.com/missing.txt" });

    await expect(request).rejects.toBeInstanceOf(FetchUrlResponseError);
    await expect(request).rejects.toMatchObject({
      url: "https://example.com/missing.txt",
      status: 404,
      statusText: "Not Found",
      contentType: "text/plain",
      bodyText: "not found details",
      bodyTruncated: false,
    });
  });

  it("truncates response body details for HTTP errors", async () => {
    stubFetch(
      new Response("abcdefghij", {
        status: 500,
        statusText: "Internal Server Error",
        headers: { "content-type": "text/plain" },
      }),
    );

    await expect(
      fetchUrl({ url: "https://example.com/error.txt", maxErrorBodyBytes: 4 }),
    ).rejects.toMatchObject({ status: 500, bodyText: "abcd", bodyTruncated: true, limitBytes: 4 });
  });

  it("caps response text and reports truncation metadata", async () => {
    stubFetch(new Response("abcdefghij", { headers: { "content-type": "text/plain" } }));

    const result = await fetchUrl({ url: "https://example.com/large.txt", maxBytes: 4 });

    expect(result).toMatchObject({ text: "abcd", truncated: true, limitBytes: 4 });
    expect(result.bytesRead).toBeGreaterThan(result.limitBytes);
  });
});

function stubFetch(response: Response): void {
  vi.stubGlobal("fetch", async () => response);
}
