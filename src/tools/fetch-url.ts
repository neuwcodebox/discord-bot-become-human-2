export async function fetchUrl(input: {
  url: string;
  timeoutMs?: number;
  maxBytes?: number;
  allowedContentTypes?: string[];
}): Promise<{
  url: string;
  contentType: string;
  text: string;
  truncated: boolean;
  bytesRead: number;
  limitBytes: number;
}> {
  const timeoutMs = input.timeoutMs ?? 10_000;
  const maxBytes = input.maxBytes ?? 262_144;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(input.url, { signal: controller.signal, redirect: "follow" });
    const contentType = response.headers.get("content-type") ?? "application/octet-stream";
    const allowedContentTypes = input.allowedContentTypes ?? [
      "text/",
      "application/json",
      "application/xml",
      "application/yaml",
      "application/x-yaml",
    ];
    if (allowedContentTypes.length && !allowedContentTypes.some((type) => contentType.includes(type))) {
      throw new Error(`Unsupported content-type: ${contentType}`);
    }
    const reader = response.body?.getReader();
    if (!reader) {
      return {
        url: response.url,
        contentType,
        text: "",
        truncated: false,
        bytesRead: 0,
        limitBytes: maxBytes,
      };
    }
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
    const text = new TextDecoder().decode(Buffer.concat(chunks));
    return { url: response.url, contentType, text, truncated, bytesRead: size, limitBytes: maxBytes };
  } finally {
    clearTimeout(timeout);
  }
}
