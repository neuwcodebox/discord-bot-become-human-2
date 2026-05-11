import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { OAuthCredentials } from "@earendil-works/pi-ai/oauth";
import { getOAuthApiKey } from "@earendil-works/pi-ai/oauth";
import type { AppConfig } from "../types.js";

export type CodexCredentials = {
  apiKey?: string;
  headers?: Record<string, string>;
};

export async function loadCodexCredentials(config: AppConfig): Promise<CodexCredentials> {
  const configured = await loadConfiguredAuthPath(config);
  if (configured.apiKey) return configured;
  return loadPiAiAuthJson(resolve(process.cwd(), "auth.json"));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function loadConfiguredAuthPath(config: AppConfig): Promise<CodexCredentials> {
  const authPath = config.llm.codex.authPath.replace(/^~(?=\/)/, process.env.HOME ?? "");
  try {
    const raw = await readFile(authPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const token =
      stringValue(parsed.access_token) ??
      stringValue(parsed.accessToken) ??
      stringValue(parsed.id_token) ??
      stringValue(parsed.jwt) ??
      stringValue(parsed.token) ??
      stringValue(parsed.access);
    return token ? { apiKey: token } : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function loadPiAiAuthJson(authPath: string): Promise<CodexCredentials> {
  try {
    const raw = await readFile(authPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, ({ type?: string } & OAuthCredentials) | undefined>;
    const credentials = Object.fromEntries(
      Object.entries(parsed)
        .filter(([, value]) => value?.type === "oauth")
        .map(([provider, value]) => [provider, stripType(value)]),
    ) as Record<string, OAuthCredentials>;
    const result = await getOAuthApiKey("openai-codex", credentials);
    if (!result) return {};
    parsed["openai-codex"] = { type: "oauth", ...result.newCredentials };
    await writeFile(authPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    return { apiKey: result.apiKey };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

function stripType(value: ({ type?: string } & OAuthCredentials) | undefined): OAuthCredentials {
  if (!value) throw new Error("Missing OAuth credentials");
  const { type: _type, ...credentials } = value;
  return credentials;
}
