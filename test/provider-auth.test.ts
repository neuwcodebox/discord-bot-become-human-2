import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../src/config.js";

vi.mock("@earendil-works/pi-ai/oauth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-ai/oauth")>();
  return {
    ...actual,
    getOAuthApiKey: vi.fn(async () => ({
      apiKey: "access-token",
      newCredentials: {
        access: "access-token",
        refresh: "refresh-token",
        expires: Date.now() + 60_000,
      },
    })),
  };
});

describe("codex auth loading", () => {
  const cwd = process.cwd();

  afterEach(() => {
    process.chdir(cwd);
    vi.restoreAllMocks();
  });

  it("loads and refreshes pi-ai OAuth credentials from the configured codex auth path", async () => {
    const temp = await mkdtemp(join(tmpdir(), "dbh2-auth-"));
    process.chdir(temp);
    const authPath = join(temp, "codex-auth.json");
    await writeFile(
      authPath,
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
    const { loadCodexCredentials } = await import("../src/agent/provider.js");

    const credentials = await loadCodexCredentials({
      ...defaultConfig,
      llm: {
        ...defaultConfig.llm,
        codex: { ...defaultConfig.llm.codex, authPath },
      },
    });

    expect(credentials.apiKey).toBe("access-token");
    await expect(readFile(authPath, "utf8")).resolves.toContain("access-token");
  });

  it("does not read pi-ai auth.json from the current working directory", async () => {
    const temp = await mkdtemp(join(tmpdir(), "dbh2-auth-"));
    process.chdir(temp);
    await writeFile(
      join(temp, "auth.json"),
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
    const { loadCodexCredentials } = await import("../src/agent/provider.js");

    const credentials = await loadCodexCredentials({
      ...defaultConfig,
      llm: {
        ...defaultConfig.llm,
        codex: { ...defaultConfig.llm.codex, authPath: join(temp, "missing-codex-auth.json") },
      },
    });

    expect(credentials.apiKey).toBeUndefined();
  });
});
