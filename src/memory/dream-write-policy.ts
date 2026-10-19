import type { AppConfig } from "../types.js";

type DreamConfig = AppConfig["memory"]["dream"];

export function dreamEditTargets(config: DreamConfig): string[] {
  return dreamWriteRules(config).map((rule) => rule.target);
}

export function assertDreamWriteAllowed(path: string, config: DreamConfig): void {
  const normalized = path.replaceAll("\\", "/").replace(/^\.?\//, "");
  if (dreamWriteRules(config).some((rule) => rule.pattern.test(normalized))) return;
  throw new Error(`Dream is not allowed to write ${path}`);
}

function dreamWriteRules(config: DreamConfig) {
  return [
    { target: "memory/MEMORY.md", pattern: /^memory\/MEMORY\.md$/, enabled: true },
    {
      target: "users/<discord_user_id>/USER.md",
      pattern: /^users\/[^/]+\/USER\.md$/,
      enabled: config.allowEditUserProfiles,
    },
    { target: "SOUL.md", pattern: /^SOUL\.md$/, enabled: config.allowEditSoul },
    { target: "GROUP.md", pattern: /^GROUP\.md$/, enabled: config.allowEditGroup },
    { target: "skills/<kebab-name>/SKILL.md", pattern: /^skills\/[^/]+\/SKILL\.md$/, enabled: true },
  ].filter((rule) => rule.enabled);
}
