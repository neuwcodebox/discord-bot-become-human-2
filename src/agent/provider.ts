import { readFile } from "node:fs/promises";
import type { AppConfig } from "../types.js";

export type CodexCredentials = {
  apiKey?: string;
  headers?: Record<string, string>;
};

export async function loadCodexCredentials(config: AppConfig): Promise<CodexCredentials> {
  const authPath = config.llm.codex.authPath.replace(/^~(?=\/)/, process.env.HOME ?? "");
  try {
    const raw = await readFile(authPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const token =
      stringValue(parsed.access_token) ??
      stringValue(parsed.accessToken) ??
      stringValue(parsed.id_token) ??
      stringValue(parsed.jwt) ??
      stringValue(parsed.token);
    return token ? { apiKey: token } : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
