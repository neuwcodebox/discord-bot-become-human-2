import type { Message, TextBasedChannel } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../src/config.js";
import { handleAdminCommand, isAdminCommand, isAdminUser } from "../src/discord/admin-commands.js";
import type { AppConfig, RuntimePaths } from "../src/types.js";

vi.mock("../src/paths/workspace-init.js", () => ({
  ensureGuildWorkspace: vi.fn().mockResolvedValue(undefined),
  ensureRuntimeRoot: vi.fn().mockResolvedValue(undefined),
  ensureUserProfile: vi.fn().mockResolvedValue(undefined),
}));

function fakeChannel(): TextBasedChannel {
  return {
    messages: { fetch: vi.fn().mockResolvedValue({ size: 0 }) },
    send: vi.fn().mockResolvedValue(fakeEditableMessage("bot reply")),
  } as unknown as TextBasedChannel;
}

function fakeEditableMessage(content: string): Message<boolean> {
  return {
    content,
    editable: true,
    edit: vi.fn().mockResolvedValue(undefined),
  } as unknown as Message<boolean>;
}

function fakeMessage(
  content: string,
  authorId: string,
  guildId: string,
  channelOverride?: Partial<TextBasedChannel>,
): Message<boolean> {
  const channel = { ...fakeChannel(), ...channelOverride };
  return {
    content,
    guildId,
    author: { id: authorId, bot: false },
    channel,
  } as unknown as Message<boolean>;
}

function fakePaths(): RuntimePaths {
  return {
    runtimeRoot: "/tmp/test-runtime",
    configPath: "/tmp/test-runtime/config.json",
    guildsRoot: "/tmp/test-runtime/guilds",
    resourcesAgentsPath: "/tmp/test-runtime/resources/agents",
  } as unknown as RuntimePaths;
}

function fakeOrchestrator(overrides?: {
  adminForceCompact?: ReturnType<typeof vi.fn>;
  adminForceDream?: ReturnType<typeof vi.fn>;
}) {
  return {
    adminForceCompact: overrides?.adminForceCompact ?? vi.fn().mockResolvedValue(undefined),
    adminForceDream: overrides?.adminForceDream ?? vi.fn().mockResolvedValue(false),
  } as unknown as import("../src/conversation/orchestrator.js").ConversationOrchestrator;
}

function adminConfig(userIds: string[] = []): AppConfig {
  return { ...defaultConfig, discord: { ...defaultConfig.discord, adminUserIds: userIds } };
}

describe("isAdminCommand", () => {
  it("matches /admin compact", () => {
    expect(isAdminCommand("/admin compact")).toBe(true);
  });

  it("matches /admin dream", () => {
    expect(isAdminCommand("/admin dream")).toBe(true);
  });

  it("does not match regular messages", () => {
    expect(isAdminCommand("hello")).toBe(false);
    expect(isAdminCommand("/help")).toBe(false);
    expect(isAdminCommand("/admincompact")).toBe(false);
  });

  it("matches with leading whitespace", () => {
    expect(isAdminCommand("  /admin compact")).toBe(true);
  });
});

describe("isAdminUser", () => {
  it("returns true for a listed user", () => {
    const config = adminConfig(["u1"]);
    expect(isAdminUser(config, "u1")).toBe(true);
  });

  it("returns false for an unlisted user", () => {
    expect(isAdminUser(defaultConfig, "u1")).toBe(false);
  });

  it("returns false when adminUserIds is empty", () => {
    expect(isAdminUser(adminConfig([]), "u1")).toBe(false);
  });
});

describe("handleAdminCommand", () => {
  it("returns false for non-admin prefix", async () => {
    const result = await handleAdminCommand({
      message: fakeMessage("hello", "u1", "g1"),
      config: adminConfig(["u1"]),
      paths: fakePaths(),
      orchestrator: fakeOrchestrator(),
    });
    expect(result).toBe(false);
  });

  it("returns false for unknown subcommand", async () => {
    const result = await handleAdminCommand({
      message: fakeMessage("/admin unknown", "u1", "g1"),
      config: adminConfig(["u1"]),
      paths: fakePaths(),
      orchestrator: fakeOrchestrator(),
    });
    expect(result).toBe(false);
  });

  it("returns false when guildId is missing", async () => {
    const msg = fakeMessage("/admin compact", "u1", "g1");
    (msg as { guildId: string | null }).guildId = null as unknown as string;
    const result = await handleAdminCommand({
      message: msg,
      config: adminConfig(["u1"]),
      paths: fakePaths(),
      orchestrator: fakeOrchestrator(),
    });
    expect(result).toBe(false);
  });

  it("replies with refusal for non-admin user and returns true", async () => {
    const sendSpy = vi.fn().mockResolvedValue(fakeEditableMessage("권한이 없습니다."));
    const channel = { ...fakeChannel(), send: sendSpy };
    const msg = fakeMessage("/admin compact", "u-unknown", "g1");
    (msg as unknown as { channel: unknown }).channel = channel;

    const result = await handleAdminCommand({
      message: msg,
      config: defaultConfig,
      paths: fakePaths(),
      orchestrator: fakeOrchestrator(),
    });

    expect(result).toBe(true);
    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({ content: "권한이 없습니다." }));
  });

  it("calls adminForceCompact and returns true for authorized /admin compact", async () => {
    const compactFn = vi.fn().mockResolvedValue(undefined);
    const editFn = vi.fn().mockResolvedValue(undefined);
    const sendFn = vi.fn().mockResolvedValue({ editable: true, edit: editFn, content: "..." });
    const channel = { ...fakeChannel(), send: sendFn };
    const msg = fakeMessage("/admin compact", "u1", "g1");
    (msg as unknown as { channel: unknown }).channel = channel;

    const result = await handleAdminCommand({
      message: msg,
      config: adminConfig(["u1"]),
      paths: fakePaths(),
      orchestrator: fakeOrchestrator({ adminForceCompact: compactFn }),
    });

    expect(result).toBe(true);
    expect(compactFn).toHaveBeenCalledOnce();
  });

  it("calls adminForceDream and returns true for authorized /admin dream", async () => {
    const dreamFn = vi.fn().mockResolvedValue(true);
    const editFn = vi.fn().mockResolvedValue(undefined);
    const sendFn = vi.fn().mockResolvedValue({ editable: true, edit: editFn, content: "..." });
    const channel = { ...fakeChannel(), send: sendFn };
    const msg = fakeMessage("/admin dream", "u1", "g1");
    (msg as unknown as { channel: unknown }).channel = channel;

    const result = await handleAdminCommand({
      message: msg,
      config: adminConfig(["u1"]),
      paths: fakePaths(),
      orchestrator: fakeOrchestrator({ adminForceDream: dreamFn }),
    });

    expect(result).toBe(true);
    expect(dreamFn).toHaveBeenCalledOnce();
  });
});
