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

const pendingCredentials = new Map<string, Promise<CodexCredentials>>();

export async function loadCodexCredentials(authPath: string): Promise<CodexCredentials> {
  const resolvedPath = expandHome(authPath);
  const pending = pendingCredentials.get(resolvedPath);
  if (pending) return pending;
  const loading = loadConfiguredAuthPath(resolvedPath);
  pendingCredentials.set(resolvedPath, loading);
  try {
    return await loading;
  } finally {
    pendingCredentials.delete(resolvedPath);
  }
}

const codexTokenClaimsSchema = z.object({
  "https://api.openai.com/auth": z.object({ chatgpt_account_id: nonEmptyString }),
});

export async function loadCodexAccountCredentials(
  authPath: string,
  signal?: AbortSignal,
): Promise<{ accessToken: string; accountId: string }> {
  signal?.throwIfAborted();
  // Never propagate auth file contents, refresh responses, or token parse errors to tool logs/context.
  try {
    const { apiKey } = await waitForCredentials(authPath, signal);
    signal?.throwIfAborted();
    const payload = apiKey?.split(".")[1];
    if (!apiKey || !payload) throw new Error("Missing OAuth access token");
    const claims = codexTokenClaimsSchema.parse(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    );
    return { accessToken: apiKey, accountId: claims["https://api.openai.com/auth"].chatgpt_account_id };
  } catch {
    signal?.throwIfAborted();
    throw new Error("Codex OAuth authentication is unavailable. Run: npm run login:codex");
  }
}

function waitForCredentials(authPath: string, signal?: AbortSignal): Promise<CodexCredentials> {
  const loading = loadCodexCredentials(authPath);
  if (!signal) return loading;
  // Cancelling one request must not abort a refresh shared with other guilds or usage checks.
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    loading.then(
      (credentials) => {
        signal.removeEventListener("abort", abort);
        resolve(credentials);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
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
    credential = await oauth.refresh(credential, AbortSignal.timeout(30_000));
    parsed["openai-codex"] = credential;
    await writeFile(authPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  }

  const auth = await oauth.toAuth(credential);
  return auth.apiKey ? { apiKey: auth.apiKey } : {};
}
