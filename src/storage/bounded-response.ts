/** Read a complete binary response, cancelling the stream rather than returning truncated data. */
export async function readBoundedResponse(response: Response, maxBytes: number): Promise<Buffer> {
  const advertisedSize = Number(response.headers.get("content-length"));
  if (advertisedSize > maxBytes) {
    await response.body?.cancel();
    throw new Error("Response exceeds the configured byte limit.");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Response body is empty.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  let complete = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        complete = true;
        return Buffer.concat(chunks);
      }
      size += value.byteLength;
      if (size > maxBytes) throw new Error("Response exceeds the configured byte limit.");
      chunks.push(value);
    }
  } finally {
    if (!complete) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
