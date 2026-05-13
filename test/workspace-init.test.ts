import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config.js";
import { createRuntimePaths, getGuildWorkspace } from "../src/paths/runtime-paths.js";
import { ensureGuildWorkspace, ensureRuntimeRoot, ensureUserProfile } from "../src/paths/workspace-init.js";

describe("workspace init", () => {
  it("creates runtime root and guild workspace without copying resources AGENTS.md", async () => {
    const temp = await mkdtemp(join(tmpdir(), "dbh2-"));
    const projectRoot = resolve(".");
    const config = {
      ...defaultConfig,
      runtime: { ...defaultConfig.runtime, rootDir: temp },
    };
    const paths = createRuntimePaths(projectRoot, config);
    await ensureRuntimeRoot(paths);
    const workspace = getGuildWorkspace(paths, "guild-a");
    await ensureGuildWorkspace(paths, workspace);

    await expect(readFile(join(workspace.workspaceRoot, "SOUL.md"), "utf8")).resolves.toContain("# Soul");
    await expect(
      readFile(join(workspace.workspaceRoot, "skills", "memory", "SKILL.md"), "utf8"),
    ).resolves.toContain("name: memory");
    await expect(readFile(join(workspace.workspaceRoot, "AGENTS.md"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps user profiles scoped to each guild workspace", async () => {
    const temp = await mkdtemp(join(tmpdir(), "dbh2-"));
    const projectRoot = resolve(".");
    const config = { ...defaultConfig, runtime: { ...defaultConfig.runtime, rootDir: temp } };
    const paths = createRuntimePaths(projectRoot, config);
    const guildA = getGuildWorkspace(paths, "a");
    const guildB = getGuildWorkspace(paths, "b");
    await ensureGuildWorkspace(paths, guildA);
    await ensureGuildWorkspace(paths, guildB);

    await ensureUserProfile(guildA.workspaceRoot, { id: "123", username: "neuw", displayName: "A name" });
    await ensureUserProfile(guildB.workspaceRoot, { id: "123", username: "neuw", displayName: "B name" });

    await expect(readFile(join(guildA.workspaceRoot, "users", "123", "USER.md"), "utf8")).resolves.toContain(
      "A name",
    );
    await expect(readFile(join(guildB.workspaceRoot, "users", "123", "USER.md"), "utf8")).resolves.toContain(
      "B name",
    );
  });

  it("does not create USER.md for bot authors", async () => {
    const temp = await mkdtemp(join(tmpdir(), "dbh2-"));
    const projectRoot = resolve(".");
    const config = { ...defaultConfig, runtime: { ...defaultConfig.runtime, rootDir: temp } };
    const paths = createRuntimePaths(projectRoot, config);
    const workspace = getGuildWorkspace(paths, "a");
    await ensureGuildWorkspace(paths, workspace);

    await ensureUserProfile(workspace.workspaceRoot, {
      id: "bot-1",
      username: "bot",
      displayName: "Bot",
      isBot: true,
    });

    await expect(
      readFile(join(workspace.workspaceRoot, "users", "bot-1", "USER.md"), "utf8"),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
