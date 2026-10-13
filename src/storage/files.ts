import { readdir, readFile } from "node:fs/promises";

export function isFileNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export async function readTextIfExists(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isFileNotFoundError(error)) return "";
    throw error;
  }
}

export async function readDirectoryIfExists(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch (error) {
    if (isFileNotFoundError(error)) return [];
    throw error;
  }
}
