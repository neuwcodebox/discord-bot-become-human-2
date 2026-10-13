import { describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../src/config.js";
import { handleAdminCommand, isAdminCommand, isAdminUser } from "../src/discord/admin-commands.js";
import { createRuntimePaths, getGuildWorkspace } from "../src/paths/runtime-paths.js";
import { createDiscordFixture } from "./helpers/discord.js";
import { createTestWorkspace } from "./helpers/workspace.js";

vi.mock("../src/paths/workspace-init.js", () => ({
  ensureGuildWorkspace: vi.fn(async () => {}),
}));

describe("admin command recognition", () => {
  it.each([
    { content: "/admin compact", recognized: true },
    { content: "/admin dream", recognized: true },
    { content: "  /admin compact", recognized: true },
    { content: "hello", recognized: false },
    { content: "/help", recognized: false },
    { content: "/admincompact", recognized: false },
  ])("recognizes=$recognized for '$content'", ({ content, recognized }) => {
    expect(isAdminCommand(content)).toBe(recognized);
  });

  it.each([
    { adminUserIds: ["u1"], authorized: true },
    { adminUserIds: ["u2"], authorized: false },
    { adminUserIds: [], authorized: false },
  ])("authorizes=$authorized with admins $adminUserIds", ({ adminUserIds, authorized }) => {
    const config = { ...defaultConfig, discord: { ...defaultConfig.discord, adminUserIds } };

    expect(isAdminUser(config, "u1")).toBe(authorized);
  });
});

describe("admin command handling", () => {
  it.each(["hello", "/admin unknown"])(
    "leaves unsupported input '%s' to normal conversation handling",
    async (content) => {
      const fixture = await createFixture(content);

      expect(await handleAdminCommand(fixture.input)).toBe(false);
      expect(fixture.discord.sentMessages).toEqual([]);
      expect(fixture.operations.adminForceCompact).not.toHaveBeenCalled();
      expect(fixture.operations.adminForceDream).not.toHaveBeenCalled();
    },
  );

  it("leaves commands outside a guild unhandled", async () => {
    const fixture = await createFixture("/admin compact");
    fixture.discord.message.guildId = null;

    expect(await handleAdminCommand(fixture.input)).toBe(false);
    expect(fixture.discord.sentMessages).toEqual([]);
    expect(fixture.operations.adminForceCompact).not.toHaveBeenCalled();
  });

  it("refuses unauthorized commands without running maintenance", async () => {
    const fixture = await createFixture("/admin compact", false);

    expect(await handleAdminCommand(fixture.input)).toBe(true);
    expect(fixture.discord.sentMessages.map((message) => message.content)).toEqual(["권한이 없습니다."]);
    expect(fixture.operations.adminForceCompact).not.toHaveBeenCalled();
    expect(fixture.operations.adminForceDream).not.toHaveBeenCalled();
  });

  it("reports when compaction has no events to process", async () => {
    const fixture = await createFixture("/admin compact");

    expect(await handleAdminCommand(fixture.input)).toBe(true);
    expect(fixture.operations.adminForceCompact).toHaveBeenCalledWith(
      getGuildWorkspace(fixture.input.paths, "g1"),
    );
    expect(fixture.discord.sentMessages.map((message) => message.content)).toEqual([
      "compaction 완료 (처리할 이벤트 없음).",
    ]);
  });

  it.each([
    { ran: true, status: "dream 완료." },
    { ran: false, status: "dream 완료 (처리할 항목 없음)." },
  ])("reports dream maintenance results when ran=$ran", async ({ ran, status }) => {
    const fixture = await createFixture("/admin dream");
    fixture.operations.adminForceDream.mockResolvedValue(ran);

    expect(await handleAdminCommand(fixture.input)).toBe(true);
    expect(fixture.operations.adminForceDream).toHaveBeenCalledWith(
      getGuildWorkspace(fixture.input.paths, "g1"),
    );
    expect(fixture.discord.sentMessages.map((message) => message.content)).toEqual([status]);
  });

  it.each(["compact", "dream"])("reports failures of authorized %s maintenance", async (subcommand) => {
    const fixture = await createFixture(`/admin ${subcommand}`);
    const error = new Error("maintenance unavailable");
    fixture.operations.adminForceCompact.mockRejectedValue(error);
    fixture.operations.adminForceDream.mockRejectedValue(error);

    expect(await handleAdminCommand(fixture.input)).toBe(true);
    expect(fixture.discord.sentMessages).toHaveLength(1);
    expect(fixture.discord.sentMessages[0]?.content).toContain("실패:");
    expect(fixture.discord.sentMessages[0]?.content).toContain(error.message);
  });
});

async function createFixture(content: string, authorized = true) {
  const root = await createTestWorkspace("dbh2-admin-");
  const discord = await createDiscordFixture({ guildId: "g1" });
  discord.message.content = content;
  const operations = {
    adminForceCompact: vi
      .fn<Parameters<typeof handleAdminCommand>[0]["orchestrator"]["adminForceCompact"]>()
      .mockResolvedValue(undefined),
    adminForceDream: vi
      .fn<Parameters<typeof handleAdminCommand>[0]["orchestrator"]["adminForceDream"]>()
      .mockResolvedValue(false),
  };
  const config = {
    ...defaultConfig,
    discord: {
      ...defaultConfig.discord,
      adminUserIds: authorized ? [discord.message.author.id] : [],
    },
    runtime: { ...defaultConfig.runtime, rootDir: root },
  };
  return {
    discord,
    operations,
    input: {
      message: discord.message,
      config,
      paths: createRuntimePaths(process.cwd(), config),
      orchestrator: operations,
    },
  };
}
