import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadCodexCredentials } from "../src/agent/provider.js";
import { createTestWorkspace } from "./helpers/workspace.js";

vi.mock("@earendil-works/pi-ai/providers/openai-codex", () => ({
  openaiCodexProvider: () => ({
    auth: {
      oauth: {
        refresh: async () => ({
          type: "oauth",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 60_000,
        }),
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
});
