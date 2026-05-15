export async function fetchUrl(input: {
  url: string;
  timeoutMs?: number;
  maxBytes?: number;
  allowedContentTypes?: string[];
  maxErrorBodyBytes?: number;
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
  const maxErrorBodyBytes = input.maxErrorBodyBytes ?? 4_096;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(input.url, { signal: controller.signal, redirect: "follow" });
    const contentType = response.headers.get("content-type") ?? "application/octet-stream";
    if (!response.ok) {
      const preview = await readTextPreview(response, maxErrorBodyBytes);
      throw new FetchUrlResponseError({
        reason: "HTTP request failed",
        url: response.url || input.url,
        status: response.status,
        statusText: response.statusText,
        contentType,
        bodyText: preview.text,
        bodyTruncated: preview.truncated,
        limitBytes: preview.limitBytes,
      });
    }
    const allowedContentTypes = input.allowedContentTypes ?? [
      "text/",
      "application/json",
      "application/xml",
      "application/yaml",
      "application/x-yaml",
    ];
    if (allowedContentTypes.length && !allowedContentTypes.some((type) => contentType.includes(type))) {
      throw new FetchUrlResponseError({
        reason: "Unsupported content-type",
        url: response.url || input.url,
        status: response.status,
        statusText: response.statusText,
        contentType,
        bodyText: "",
        bodyTruncated: false,
        limitBytes: 0,
      });
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

type FetchUrlResponseErrorDetails = {
  reason: string;
  url: string;
  status: number;
  statusText: string;
  contentType: string;
  bodyText: string;
  bodyTruncated: boolean;
  limitBytes: number;
};

export class FetchUrlResponseError extends Error {
  readonly url: string;
  readonly status: number;
  readonly statusText: string;
  readonly contentType: string;
  readonly bodyText: string;
  readonly bodyTruncated: boolean;
  readonly limitBytes: number;

  constructor(details: FetchUrlResponseErrorDetails) {
    super(formatFetchUrlResponseError(details));
    this.name = "FetchUrlResponseError";
    this.url = details.url;
    this.status = details.status;
    this.statusText = details.statusText;
    this.contentType = details.contentType;
    this.bodyText = details.bodyText;
    this.bodyTruncated = details.bodyTruncated;
    this.limitBytes = details.limitBytes;
  }
}

function formatFetchUrlResponseError(details: FetchUrlResponseErrorDetails): string {
  const statusText = details.statusText ? ` ${details.statusText}` : "";
  const body = details.bodyText
    ? `; bodyPreview=${JSON.stringify(details.bodyText)}${
        details.bodyTruncated ? ` (truncated at ${details.limitBytes} bytes)` : ""
      }`
    : "";
  return `${details.reason}: ${details.status}${statusText}; url=${details.url}; contentType=${details.contentType}${body}`;
}

async function readTextPreview(
  response: Response,
  limitBytes: number,
): Promise<{ text: string; truncated: boolean; bytesRead: number; limitBytes: number }> {
  const reader = response.body?.getReader();
  if (!reader || limitBytes <= 0) {
    return { text: "", truncated: false, bytesRead: 0, limitBytes };
  }

  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limitBytes) {
      truncated = true;
      chunks.push(value.slice(0, Math.max(0, value.byteLength - (size - limitBytes))));
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }

  return {
    text: new TextDecoder().decode(Buffer.concat(chunks)),
    truncated,
    bytesRead: size,
    limitBytes,
  };
}
