import { readFile, writeFile } from "node:fs/promises";
import type { OAuthCredentials } from "@earendil-works/pi-ai/oauth";
import { getOAuthApiKey } from "@earendil-works/pi-ai/oauth";
import { z } from "zod";
import { expandHome } from "../paths/runtime-paths.js";
import type { AppConfig } from "../types.js";

const nonEmptyString = z.string().min(1);
const piAiOAuthEntrySchema = z
  .object({
    type: z.literal("oauth"),
    access: nonEmptyString,
    refresh: nonEmptyString,
    expires: z.number(),
  })
  .passthrough();
const codexAuthFileSchema = z
  .object({
    "openai-codex": piAiOAuthEntrySchema.optional(),
    access_token: nonEmptyString.optional(),
    accessToken: nonEmptyString.optional(),
    id_token: nonEmptyString.optional(),
    jwt: nonEmptyString.optional(),
    token: nonEmptyString.optional(),
    access: nonEmptyString.optional(),
  })
  .passthrough();

type CodexAuthFile = z.infer<typeof codexAuthFileSchema>;
type PiAiOAuthEntry = z.infer<typeof piAiOAuthEntrySchema>;

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
    const parsed = codexAuthFileSchema.parse(JSON.parse(raw));
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

async function loadPiAiOAuthAuth(parsed: CodexAuthFile, authPath: string): Promise<CodexCredentials> {
  const codexAuth = parsed["openai-codex"];
  if (!codexAuth) return {};
  const result = await getOAuthApiKey("openai-codex", {
    "openai-codex": stripType(codexAuth),
  });
  if (!result) return {};
  parsed["openai-codex"] = { type: "oauth", ...result.newCredentials };
  await writeFile(authPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  return { apiKey: result.apiKey };
}

function stripType(value: PiAiOAuthEntry): OAuthCredentials {
  const { type: _type, ...credentials } = value;
  return credentials;
}
