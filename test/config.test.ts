import { describe, expect, it } from "vitest";
import { defaultConfig, parseConfig } from "../src/config.js";

describe("config parsing", () => {
  it("keeps usage limiting opt-in for existing Codex configs", () => {
    if (defaultConfig.llm.provider !== "openai-codex") throw new Error("Expected Codex defaults");
    const { usageLimit: _usageLimit, ...codex } = defaultConfig.llm.codex;
    const parsed = parseConfig({ ...defaultConfig, llm: { ...defaultConfig.llm, codex } });
    expect(parsed.llm).toMatchObject({
      codex: { usageLimit: { enabled: false, minRemainingPercent: 20, pollIntervalMs: 60_000 } },
    });
  });

  it.each([
    { minRemainingPercent: -1 },
    { minRemainingPercent: 101 },
    { pollIntervalMs: 9999 },
    { pollIntervalMs: 3_600_001 },
  ])("rejects invalid usage limit settings: %s", (usageLimit) => {
    if (defaultConfig.llm.provider !== "openai-codex") throw new Error("Expected Codex defaults");
    const llm = defaultConfig.llm;
    expect(() =>
      parseConfig({ ...defaultConfig, llm: { ...llm, codex: { ...llm.codex, usageLimit } } }),
    ).toThrow();
  });

  it("fills image defaults for existing configs and allows disabling the tools", () => {
    const { images: _images, ...oldConfig } = defaultConfig;
    const { imageGeneration: _imageGeneration, ...tools } = oldConfig.tools;
    const parsed = parseConfig({ ...oldConfig, tools });
    expect(parsed.tools.imageGeneration).toBe(true);
    expect(parsed.images).toEqual({
      timeoutMs: 180_000,
      maxInputBytes: 20 * 1024 * 1024,
      maxOutputBytes: 20 * 1024 * 1024,
    });
    expect(
      parseConfig({ ...defaultConfig, tools: { ...defaultConfig.tools, imageGeneration: false } }).tools
        .imageGeneration,
    ).toBe(false);
  });

  it.each([{ timeoutMs: 0 }, { maxInputBytes: -1 }, { maxOutputBytes: 33 * 1024 * 1024 }])(
    "rejects invalid image limits",
    (images) => {
      expect(() => parseConfig({ ...defaultConfig, images })).toThrow();
    },
  );

  it("fills follow-up batch defaults for existing config files", () => {
    const { followUpBatch: _followUpBatch, ...engaged } = defaultConfig.conversation.engaged;
    const input = {
      ...defaultConfig,
      conversation: { ...defaultConfig.conversation, engaged },
    };

    const parsed = parseConfig(input);

    expect(parsed.conversation.engaged.followUpBatch).toEqual({
      quietDebounceMs: [3000, 5000],
      directTriggerDebounceMs: [1000, 2000],
      maxWaitMs: 15000,
      maxMessages: 4,
    });
  });

  it("fills context defaults for existing config files", () => {
    const { context: _context, ...input } = defaultConfig;

    const parsed = parseConfig(input);

    expect(parsed.context.outputReserveTokens).toBe(16_000);
    expect(parsed.context.maxToolResultChars).toBe(16_000);
    expect(parsed.context.maxFileReadBytes).toBe(131_072);
  });

  it("fills ambient decision cooldown for existing config files", () => {
    const { ambientDecisionCooldownMs: _cooldown, ...notEngaged } = defaultConfig.conversation.notEngaged;
    const input = {
      ...defaultConfig,
      conversation: { ...defaultConfig.conversation, notEngaged },
    };

    const parsed = parseConfig(input);

    expect(parsed.conversation.notEngaged.ambientDecisionCooldownMs).toBe(900000);
  });

  it("ignores obsolete direct trigger confidence config", () => {
    const input = {
      ...defaultConfig,
      conversation: {
        ...defaultConfig.conversation,
        notEngaged: {
          ...defaultConfig.conversation.notEngaged,
          directTriggerConfidence: 0.5,
        },
      },
    };

    const parsed = parseConfig(input);
    expect(parsed.conversation.notEngaged).not.toHaveProperty("directTriggerConfidence");
  });

  it("defaults adminUserIds to empty array when absent", () => {
    const { adminUserIds: _adminUserIds, ...discord } = defaultConfig.discord;
    const input = { ...defaultConfig, discord };

    const parsed = parseConfig(input);

    expect(parsed.discord.adminUserIds).toEqual([]);
  });

  it("accepts adminUserIds list", () => {
    const parsed = parseConfig({
      ...defaultConfig,
      discord: { ...defaultConfig.discord, adminUserIds: ["123456789"] },
    });

    expect(parsed.discord.adminUserIds).toEqual(["123456789"]);
  });
});
