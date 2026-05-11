import { readFile, writeFile } from "node:fs/promises";
import type { OAuthCredentials } from "@earendil-works/pi-ai/oauth";
import { getOAuthApiKey } from "@earendil-works/pi-ai/oauth";
import { expandHome } from "../paths/runtime-paths.js";
import type { AppConfig } from "../types.js";

export type CodexCredentials = {
  apiKey?: string;
  headers?: Record<string, string>;
};

export async function loadCodexCredentials(config: AppConfig): Promise<CodexCredentials> {
  return loadConfiguredAuthPath(config);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function loadConfiguredAuthPath(config: AppConfig): Promise<CodexCredentials> {
  const authPath = expandHome(config.llm.codex.authPath);
  try {
    const raw = await readFile(authPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const oauth = await loadPiAiOAuthAuth(parsed, authPath);
    if (oauth.apiKey) return oauth;
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

async function loadPiAiOAuthAuth(
  parsed: Record<string, unknown>,
  authPath: string,
): Promise<CodexCredentials> {
  const codexAuth = parsed["openai-codex"];
  if (!isOAuthEntry(codexAuth)) return {};
  const result = await getOAuthApiKey("openai-codex", {
    "openai-codex": stripType(codexAuth),
  });
  if (!result) return {};
  parsed["openai-codex"] = { type: "oauth", ...result.newCredentials };
  await writeFile(authPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  return { apiKey: result.apiKey };
}

function isOAuthEntry(value: unknown): value is { type?: string } & OAuthCredentials {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "oauth" &&
    typeof (value as { access?: unknown }).access === "string" &&
    typeof (value as { refresh?: unknown }).refresh === "string" &&
    typeof (value as { expires?: unknown }).expires === "number"
  );
}

function stripType(value: { type?: string } & OAuthCredentials): OAuthCredentials {
  const { type: _type, ...credentials } = value;
  return credentials;
}
