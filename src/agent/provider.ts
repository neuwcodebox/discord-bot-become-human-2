import { readFile, writeFile } from "node:fs/promises";
import type { OAuthCredential } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { z } from "zod";
import { expandHome } from "../paths/runtime-paths.js";

const nonEmptyString = z.string().min(1);
const piAiOAuthEntrySchema = z
  .object({
    type: z.literal("oauth"),
    access: nonEmptyString,
    refresh: nonEmptyString,
    expires: z.number(),
  })
  .loose();
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
  .loose();

type CodexAuthFile = z.infer<typeof codexAuthFileSchema>;
export type CodexCredentials = {
  apiKey?: string;
};

export async function loadCodexCredentials(authPath: string): Promise<CodexCredentials> {
  return loadConfiguredAuthPath(expandHome(authPath));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function loadConfiguredAuthPath(resolvedPath: string): Promise<CodexCredentials> {
  try {
    const raw = await readFile(resolvedPath, "utf8");
    const parsed = codexAuthFileSchema.parse(JSON.parse(raw));
    const oauth = await loadPiAiOAuthAuth(parsed, resolvedPath);
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
  const oauth = openaiCodexProvider().auth.oauth;
  if (!oauth) throw new Error("OpenAI Codex OAuth is not available");

  let credential: OAuthCredential = codexAuth;
  if (credential.expires <= Date.now() + 5 * 60_000) {
    credential = await oauth.refresh(credential, new AbortController().signal);
    parsed["openai-codex"] = credential;
    await writeFile(authPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  }

  const auth = await oauth.toAuth(credential);
  return auth.apiKey ? { apiKey: auth.apiKey } : {};
}
