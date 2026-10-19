import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config.js";
import { assertDreamWriteAllowed, dreamEditTargets } from "../src/memory/dream-write-policy.js";

const defaults = defaultConfig.memory.dream;

describe("Dream write policy", () => {
  it.each([
    { setting: "allowEditSoul", target: "SOUL.md", path: "SOUL.md" },
    { setting: "allowEditGroup", target: "GROUP.md", path: "GROUP.md" },
    { setting: "allowEditUserProfiles", target: "users/<discord_user_id>/USER.md", path: "users/u1/USER.md" },
  ] as const)("keeps declared and enforced $setting permissions aligned", ({ setting, target, path }) => {
    for (const enabled of [false, true]) {
      const config = { ...defaults, [setting]: enabled };
      expect(dreamEditTargets(config).includes(target)).toBe(enabled);
      const write = () => assertDreamWriteAllowed(path, config);
      if (enabled) expect(write).not.toThrow();
      else expect(write).toThrow("Dream is not allowed to write");
    }
  });

  it("always allows guild memory and skill documents", () => {
    const config = { ...defaults, allowEditSoul: false, allowEditGroup: false, allowEditUserProfiles: false };
    expect(dreamEditTargets(config)).toEqual(["memory/MEMORY.md", "skills/<kebab-name>/SKILL.md"]);
    for (const path of ["memory/MEMORY.md", "./memory/MEMORY.md", "skills/weather/SKILL.md"]) {
      expect(() => assertDreamWriteAllowed(path, config)).not.toThrow();
    }
  });

  it.each([
    "TOOLS.md",
    "memory/events.jsonl",
    "memory/.dream_cursor",
    "users/u1/aliases.json",
    "users/u1/nested/USER.md",
    "skills/weather/script.js",
    "skills/weather/nested/SKILL.md",
    "../SOUL.md",
    "memory/../SOUL.md",
  ])("rejects paths outside the editable document scope: %s", (path) => {
    expect(() => assertDreamWriteAllowed(path, defaults)).toThrow("Dream is not allowed to write");
  });
});
