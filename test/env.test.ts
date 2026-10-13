import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadDotenvFile } from "../src/env.js";
import { createTestWorkspace } from "./helpers/workspace.js";

describe("dotenv loading", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("loads an existing dotenv file without overriding existing environment variables", async () => {
    const root = await createTestWorkspace("dbh-env-");
    const envPath = join(root, ".env");
    const existingKey = "DBH_DOTENV_EXISTING";
    const loadedKey = "DBH_DOTENV_LOADED";
    vi.stubEnv(existingKey, "from-process");
    vi.stubEnv(loadedKey, undefined);

    await writeFile(envPath, `${existingKey}=from-dotenv\n${loadedKey}=loaded\n`, "utf8");

    expect(loadDotenvFile(envPath)).toBe(true);
    expect(process.env[existingKey]).toBe("from-process");
    expect(process.env[loadedKey]).toBe("loaded");
  });

  it("skips missing dotenv files", async () => {
    const root = await createTestWorkspace("dbh-env-");

    expect(loadDotenvFile(join(root, ".env"))).toBe(false);
  });
});
