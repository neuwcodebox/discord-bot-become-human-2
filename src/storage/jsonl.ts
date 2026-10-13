import { createReadStream } from "node:fs";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { isFileNotFoundError, readTextIfExists } from "./files.js";

export async function appendJsonl(path: string, value: unknown, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await mkdir(dirname(path), { recursive: true });
  signal?.throwIfAborted();
  await appendFile(path, `${JSON.stringify(value)}\n`, { encoding: "utf8", ...(signal ? { signal } : {}) });
}

export async function readJsonl<T>(path: string, limit?: number): Promise<T[]> {
  const values: T[] = [];
  try {
    const stream = createReadStream(path, { encoding: "utf8" });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      values.push(JSON.parse(line) as T);
      if (limit !== undefined && values.length >= limit) break;
    }
  } catch (error) {
    if (!isFileNotFoundError(error)) throw error;
  }
  return values;
}

export async function readLastJsonl<T>(path: string, limit: number): Promise<T[]> {
  const all = await readJsonl<T>(path);
  return all.slice(Math.max(0, all.length - limit));
}

export async function readCursor(path: string): Promise<number> {
  const raw = await readTextIfExists(path);
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function writeCursor(path: string, value: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${value}\n`, "utf8");
}
