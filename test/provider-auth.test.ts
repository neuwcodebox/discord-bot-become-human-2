import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadCodexCredentials, loadCodexImageCredentials } from "../src/agent/provider.js";
import { createTestWorkspace } from "./helpers/workspace.js";

const refresh = vi.hoisted(() =>
  vi.fn(async () => ({
    type: "oauth",
    access: "access-token",
    refresh: "refresh-token",
    expires: Date.now() + 60_000,
  })),
);

vi.mock("@earendil-works/pi-ai/providers/openai-codex", () => ({
  openaiCodexProvider: () => ({
    auth: {
      oauth: {
        refresh,
        toAuth: async (credential: { access: string }) => ({ apiKey: credential.access }),
      },
    },
  }),
}));

async function writeExpiredCredentials(path: string): Promise<void> {
  await writeFile(
    path,
    JSON.stringify({
      "openai-codex": {
        type: "oauth",
        access: "old-access",
        refresh: "refresh-token",
        expires: 1,
      },
    }),
    "utf8",
  );
}

describe("codex auth loading", () => {
  const cwd = process.cwd();
  let root = "";

  beforeEach(async () => {
    refresh.mockClear();
    root = await createTestWorkspace("dbh2-auth-");
    process.chdir(root);
  });

  afterEach(() => {
    process.chdir(cwd);
  });

  it("loads and refreshes pi-ai OAuth credentials from the configured codex auth path", async () => {
    const authPath = join(root, "codex-auth.json");
    await writeExpiredCredentials(authPath);

    const credentials = await loadCodexCredentials(authPath);

    expect(credentials.apiKey).toBe("access-token");
    const stored: unknown = JSON.parse(await readFile(authPath, "utf8"));
    expect(stored).toMatchObject({ "openai-codex": { access: "access-token" } });
  });

  it("does not read pi-ai auth.json from the current working directory", async () => {
    await writeExpiredCredentials(join(root, "auth.json"));

    const credentials = await loadCodexCredentials(join(root, "missing-codex-auth.json"));

    expect(credentials.apiKey).toBeUndefined();
  });

  it("shares one refresh across concurrent conversation and image credential loads", async () => {
    const authPath = join(root, "codex-auth.json");
    await writeExpiredCredentials(authPath);
    await Promise.all([
      loadCodexCredentials(authPath),
      loadCodexCredentials(authPath),
      loadCodexImageCredentials(authPath).catch(() => undefined),
    ]);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("extracts the image account ID from the configured OAuth token", async () => {
    const authPath = join(root, "codex-auth.json");
    const claims = Buffer.from(
      JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account" } }),
    ).toString("base64url");
    const accessToken = `header.${claims}.signature`;
    await writeFile(
      authPath,
      JSON.stringify({
        "openai-codex": {
          type: "oauth",
          access: accessToken,
          refresh: "refresh-token",
          expires: Date.now() + 3_600_000,
        },
      }),
    );
    await expect(loadCodexImageCredentials(authPath)).resolves.toEqual({ accessToken, accountId: "account" });
  });

  it("keeps token parse failures private and never falls back to cwd auth.json for images", async () => {
    await writeExpiredCredentials(join(root, "auth.json"));
    const authPath = join(root, "codex-auth.json");
    await expect(loadCodexImageCredentials(authPath)).rejects.toThrow(/login:codex/);
    await writeFile(authPath, JSON.stringify({ access_token: "private-token" }));
    let failure: unknown;
    try {
      await loadCodexImageCredentials(authPath);
    } catch (error) {
      failure = error;
    }
    expect(String(failure)).not.toContain("private-token");
    expect(String(failure)).toContain("login:codex");
  });

  it("cancels an image auth wait without cancelling the shared conversation refresh", async () => {
    const authPath = join(root, "codex-auth.json");
    await writeExpiredCredentials(authPath);
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof refresh>>>();
    refresh.mockReturnValueOnce(pending.promise);
    const conversation = loadCodexCredentials(authPath);
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    const controller = new AbortController();
    const image = loadCodexImageCredentials(authPath, controller.signal);
    controller.abort();
    await expect(image).rejects.toThrow(/abort/i);
    pending.resolve({
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 3_600_000,
    });
    await expect(conversation).resolves.toEqual({ apiKey: "access-token" });
    expect(refresh).toHaveBeenCalledOnce();
  });
});
