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
});
