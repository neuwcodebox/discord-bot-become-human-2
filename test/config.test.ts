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
});
