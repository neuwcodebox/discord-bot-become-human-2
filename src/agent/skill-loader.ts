import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseDocument } from "yaml";

export type SkillMetadata = {
  name: string;
  description: string;
  path: string;
  always?: boolean;
};

export type LoadedSkill = SkillMetadata & {
  body: string;
};

export class SkillLoader {
  constructor(private readonly workspaceRoot: string) {}

  async discover(): Promise<SkillMetadata[]> {
    const skillsRoot = join(this.workspaceRoot, "skills");
    let entries: string[];
    try {
      entries = await readdir(skillsRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const skills: SkillMetadata[] = [];
    for (const entry of entries) {
      const skillPath = join(skillsRoot, entry, "SKILL.md");
      try {
        const raw = await readFile(skillPath, "utf8");
        const { metadata } = parseSkillMarkdown(raw);
        if (!metadata.name || !metadata.description) continue;
        skills.push({
          name: metadata.name,
          description: metadata.description,
          path: skillPath,
          ...(metadata.always === undefined ? {} : { always: metadata.always }),
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return skills.sort((a, b) => a.name.localeCompare(b.name));
  }

  async load(names: string[]): Promise<LoadedSkill[]> {
    const wanted = new Set(names);
    const discovered = await this.discover();
    const selected = discovered.filter((skill) => wanted.has(skill.name) || skill.always);
    return Promise.all(
      selected.map(async (skill) => ({
        ...skill,
        body: await readFile(skill.path, "utf8"),
      })),
    );
  }
}

function parseSkillMarkdown(raw: string): {
  metadata: { name?: string; description?: string; always?: boolean };
} {
  if (!raw.startsWith("---\n")) return { metadata: {} };
  const end = raw.indexOf("\n---", 4);
  if (end === -1) return { metadata: {} };
  const yaml = raw.slice(4, end);
  const parsed = parseDocument(yaml).toJSON() as {
    name?: unknown;
    description?: unknown;
    always?: unknown;
  } | null;
  const metadata: { name?: string; description?: string; always?: boolean } = {};
  if (typeof parsed?.name === "string") metadata.name = parsed.name;
  if (typeof parsed?.description === "string") metadata.description = parsed.description;
  if (typeof parsed?.always === "boolean") metadata.always = parsed.always;
  return { metadata };
}
