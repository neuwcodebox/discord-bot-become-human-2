import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { SkillLoader } from "../src/agent/skill-loader.js";
import { createTestWorkspace } from "./helpers/workspace.js";

describe("skill loader", () => {
  let root = "";
  let loader: SkillLoader;

  beforeEach(async () => {
    root = await createTestWorkspace("dbh2-skills-");
    loader = new SkillLoader(root);
  });

  async function writeSkill(directory: string, contents: string): Promise<string> {
    const path = join(root, "skills", directory, "SKILL.md");
    await mkdir(join(root, "skills", directory), { recursive: true });
    await writeFile(path, contents, "utf8");
    return path;
  }

  it("returns empty context when the skills directory is absent", async () => {
    await expect(loader.discover()).resolves.toEqual([]);
    await expect(loader.load(["missing"])).resolves.toEqual([]);
    await expect(loader.buildSkillsContext()).resolves.toEqual({ alwaysLoaded: [], summary: "" });
  });

  it("discovers sorted names, multiline descriptions, and boolean activation metadata", async () => {
    const zetaPath = await writeSkill(
      "zeta",
      "---\nname: zeta\ndescription: Last skill\nalways: false\nextra: ignored\n---\nZeta body",
    );
    const alphaPath = await writeSkill(
      "alpha",
      "---\nname: alpha\ndescription: >-\n  First skill\n  with details\nalways: true\n---\nAlpha body",
    );

    await expect(loader.discover()).resolves.toEqual([
      { name: "alpha", description: "First skill with details", always: true, path: alphaPath },
      { name: "zeta", description: "Last skill", always: false, path: zetaPath },
    ]);
  });

  it("ignores invalid required metadata and missing skill files", async () => {
    const invalidDocuments = [
      "No frontmatter",
      "---\nname: unterminated\ndescription: Missing delimiter",
      "---\nname: 123\ndescription: Numeric name\n---\nBody",
      "---\nname: invalid\ndescription: [not, text]\n---\nBody",
      "---\nname: ''\ndescription: Empty name\n---\nBody",
      "---\nname: no-description\n---\nBody",
      "---\n- a sequence\n---\nBody",
      "---\nnull\n---\nBody",
    ];
    for (const [index, contents] of invalidDocuments.entries()) {
      await writeSkill(`invalid-${index}`, contents);
    }
    await mkdir(join(root, "skills", "missing-file"));

    await expect(loader.discover()).resolves.toEqual([]);
  });

  it("keeps valid metadata while ignoring a non-boolean always field", async () => {
    const path = await writeSkill(
      "optional",
      "---\nname: optional\ndescription: Available on demand\nalways: 'true'\n---\nBody",
    );

    await expect(loader.discover()).resolves.toEqual([
      { name: "optional", description: "Available on demand", path },
    ]);
    await expect(loader.load([])).resolves.toEqual([]);
  });

  it("loads selected and always-active skills while stripping CRLF frontmatter", async () => {
    const alwaysPath = await writeSkill(
      "always",
      "---\nname: always\ndescription: Always active\nalways: true\n---\nAlways body\n",
    );
    const selectedPath = await writeSkill(
      "selected",
      "---\r\nname: selected\r\ndescription: Selected skill\r\n---\r\n\r\n  Selected body\r\n",
    );
    await writeSkill("unused", "---\nname: unused\ndescription: Not selected\n---\nUnused body");

    await expect(loader.load(["selected", "selected", "missing"])).resolves.toEqual([
      {
        name: "always",
        description: "Always active",
        always: true,
        path: alwaysPath,
        body: "Always body\n",
      },
      { name: "selected", description: "Selected skill", path: selectedPath, body: "Selected body\n" },
    ]);
  });

  it("puts only on-demand skills in the discovery summary", async () => {
    await writeSkill(
      "always",
      "---\nname: always\ndescription: Always active\nalways: true\n---\nAlways body",
    );
    await writeSkill("optional", "---\nname: optional\ndescription: Available on demand\n---\nBody");

    const context = await loader.buildSkillsContext();

    expect(context.alwaysLoaded.map((skill) => skill.name)).toEqual(["always"]);
    expect(context.summary).toBe("- **optional** — Available on demand  `skills/optional/SKILL.md`");
  });

  it("propagates filesystem errors other than missing files", async () => {
    await writeFile(join(root, "skills"), "not a directory", "utf8");

    await expect(loader.discover()).rejects.toMatchObject({ code: "ENOTDIR" });
  });

  it("propagates errors when a skill file is a directory", async () => {
    await mkdir(join(root, "skills", "invalid", "SKILL.md"), { recursive: true });

    await expect(loader.discover()).rejects.toMatchObject({ code: "EISDIR" });
  });
});
