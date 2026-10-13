import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";
import { readDirectoryIfExists, readTextIfExists } from "../storage/files.js";

const skillMetadataSchema = z.object({
  name: z.string().catch(""),
  description: z.string().catch(""),
  always: z.boolean().optional().catch(undefined),
});

export type SkillMetadata = z.infer<typeof skillMetadataSchema> & {
  path: string;
};

export type LoadedSkill = SkillMetadata & {
  body: string;
};

export type SkillsContext = {
  alwaysLoaded: LoadedSkill[];
  summary: string;
};

export class SkillLoader {
  constructor(private readonly workspaceRoot: string) {}

  async discover(): Promise<SkillMetadata[]> {
    const skillsRoot = join(this.workspaceRoot, "skills");
    const entries = await readDirectoryIfExists(skillsRoot);
    const skills: SkillMetadata[] = [];
    for (const entry of entries) {
      const skillPath = join(skillsRoot, entry, "SKILL.md");
      const raw = await readTextIfExists(skillPath);
      const metadata = parseSkillMetadata(raw);
      if (!metadata?.name || !metadata.description) continue;
      skills.push({
        name: metadata.name,
        description: metadata.description,
        path: skillPath,
        ...(metadata.always === undefined ? {} : { always: metadata.always }),
      });
    }
    return skills.sort((a, b) => a.name.localeCompare(b.name));
  }

  async load(names: string[]): Promise<LoadedSkill[]> {
    const wanted = new Set(names);
    const discovered = await this.discover();
    const selected = discovered.filter((skill) => wanted.has(skill.name) || skill.always);
    return Promise.all(selected.map(loadSkill));
  }

  async buildSkillsContext(): Promise<SkillsContext> {
    const discovered = await this.discover();
    const alwaysSkills = discovered.filter((s) => s.always === true);
    const otherSkills = discovered.filter((s) => s.always !== true);

    const alwaysLoaded = await Promise.all(alwaysSkills.map(loadSkill));

    const summary = otherSkills
      .map((s) => `- **${s.name}** — ${s.description}  \`${relative(this.workspaceRoot, s.path)}\``)
      .join("\n");

    return { alwaysLoaded, summary };
  }
}

async function loadSkill(skill: SkillMetadata): Promise<LoadedSkill> {
  return { ...skill, body: splitSkillMarkdown(await readFile(skill.path, "utf8")).body };
}

function parseSkillMetadata(raw: string): z.infer<typeof skillMetadataSchema> | undefined {
  const { frontmatter } = splitSkillMarkdown(raw);
  if (frontmatter === undefined) return undefined;
  const parsed: unknown = parseDocument(frontmatter).toJSON();
  const result = skillMetadataSchema.safeParse(parsed);
  return result.success ? result.data : undefined;
}

function splitSkillMarkdown(raw: string): { frontmatter?: string; body: string } {
  const normalized = raw.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return { body: raw };
  const end = normalized.indexOf("\n---", 4);
  if (end === -1) return { body: raw };
  const after = normalized.slice(end + 4);
  return {
    frontmatter: normalized.slice(4, end),
    body: (after.startsWith("\n") ? after.slice(1) : after).trimStart(),
  };
}
