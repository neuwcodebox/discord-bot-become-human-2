import { describe, expect, it } from "vitest";
import { defaultConfig, parseConfig } from "../src/config.js";

describe("config parsing", () => {
  it("fills Windows sandbox defaults for existing config files", () => {
    const { windows: _windows, ...sandbox } = defaultConfig.sandbox;
    expect(parseConfig({ ...defaultConfig, sandbox }).sandbox.windows).toEqual({ readonlyPaths: [] });
  });

  it("accepts operator-approved Windows readonly tool paths", () => {
    const sandbox = { ...defaultConfig.sandbox, windows: { readonlyPaths: ["C:\\Tools\\Python"] } };
    expect(parseConfig({ ...defaultConfig, sandbox }).sandbox.windows.readonlyPaths).toEqual([
      "C:\\Tools\\Python",
    ]);
  });
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
