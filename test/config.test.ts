import { describe, expect, it } from "vitest";
import { defaultConfig, parseConfig } from "../src/config.js";
import type { AppConfig } from "../src/types.js";

describe("config parsing", () => {
  it("fills follow-up batch defaults for existing config files", () => {
    const input = structuredClone(defaultConfig);
    delete (input.conversation.engaged as Partial<AppConfig["conversation"]["engaged"]>).followUpBatch;

    const parsed = parseConfig(input);

    expect(parsed.conversation.engaged.followUpBatch).toEqual(
      defaultConfig.conversation.engaged.followUpBatch,
    );
  });

  it("fills context defaults for existing config files", () => {
    const input = structuredClone(defaultConfig);
    delete (input as Partial<AppConfig>).context;

    const parsed = parseConfig(input);

    expect(parsed.context.outputReserveTokens).toBe(16_000);
    expect(parsed.context.maxToolResultChars).toBe(16_000);
    expect(parsed.context.maxFileReadBytes).toBe(131_072);
  });

  it("defaults adminUserIds to empty array when absent", () => {
    const input = structuredClone(defaultConfig);
    delete (input.discord as Partial<AppConfig["discord"]>).adminUserIds;

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
