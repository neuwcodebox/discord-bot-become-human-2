import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadDotenvFile } from "../src/env.js";

describe("dotenv loading", () => {
  it("loads an existing dotenv file without overriding existing environment variables", async () => {
    const root = await mkdtemp(join(tmpdir(), "dbh-env-"));
    const envPath = join(root, ".env");
    const existingKey = "DBH_DOTENV_EXISTING";
    const loadedKey = "DBH_DOTENV_LOADED";
    const previousExisting = process.env[existingKey];
    const previousLoaded = process.env[loadedKey];
    process.env[existingKey] = "from-process";

    try {
      await writeFile(envPath, `${existingKey}=from-dotenv\n${loadedKey}=loaded\n`, "utf8");

      expect(loadDotenvFile(envPath)).toBe(true);
      expect(process.env[existingKey]).toBe("from-process");
      expect(process.env[loadedKey]).toBe("loaded");
    } finally {
      if (previousExisting === undefined) {
        delete process.env[existingKey];
      } else {
        process.env[existingKey] = previousExisting;
      }
      if (previousLoaded === undefined) {
        delete process.env[loadedKey];
      } else {
        process.env[loadedKey] = previousLoaded;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("skips missing dotenv files", () => {
    expect(loadDotenvFile(join(tmpdir(), "missing-discord-bot-become-human-2.env"))).toBe(false);
  });
});
