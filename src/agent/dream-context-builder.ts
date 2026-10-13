import { readFile } from "node:fs/promises";
import { block, sections } from "../context/format.js";
import { truncateText } from "../context/limits.js";
import type { AgentContextMessage, AppConfig, HistoryEntry, MemoryInboxEntry } from "../types.js";
import { SkillLoader } from "./skill-loader.js";

export type DreamContextInput = {
  agentsPath: string;
  workspaceRoot: string;
  history: HistoryEntry[];
  inbox: MemoryInboxEntry[];
  memory: string;
  soul?: string;
  group?: string;
  userFiles: Map<string, string>;
  existingSkillNames: string[];
  config: AppConfig;
  reason: string;
};

export async function buildDreamPhase1Context(input: DreamContextInput): Promise<AgentContextMessage[]> {
  const agents = await readFile(input.agentsPath, "utf8");
  const dream = input.config.memory.dream;

  const writableFiles = ["memory/MEMORY.md"];
  if (dream.allowEditUserProfiles) writableFiles.push("users/<discord_user_id>/USER.md");
  if (dream.allowEditSoul) writableFiles.push("SOUL.md");
  if (dream.allowEditGroup) writableFiles.push("GROUP.md");
  writableFiles.push("skills/<kebab-name>/SKILL.md");

  return [
    {
      role: "system",
      content: sections(
        `You are reviewing recent conversation history to decide what memory changes are needed.
Do NOT edit files. Output a structured analysis only.

Output format — one finding per line:
[FILE memory/MEMORY.md] atomic fact to add or update
[FILE users/<discord_user_id>/USER.md] user-specific fact to add
[FILE-REMOVE memory/MEMORY.md] short description of content to remove and why
[SKILL kebab-case-name] one-line description of a reusable workflow
[SKIP] if nothing needs updating

Rules:
- [FILE]: extract atomic, durable facts. "prefers ko-KR" not "discussed language"
- [FILE-REMOVE]: only for content that is objectively stale, superseded, or duplicated elsewhere
- [SKILL]: only when a specific multi-step workflow appeared 2+ times in history with clear steps
- Write one line per finding; multiple findings for the same file are fine
- Do not add: transient errors, one-off jokes, simple acknowledgements, debug logs`,
        block("instructions", agents),
        block("guardrails", memoryGuardrails),
        block(
          "scope",
          JSON.stringify(
            {
              reason: input.reason,
              writableFiles,
            },
            null,
            2,
          ),
        ),
      ),
    },
    {
      role: "user",
      content: sections(
        block("current_date", new Date().toISOString().slice(0, 10)),
        block("history", formatHistoryEntries(input.history)),
        block("inbox", input.inbox.map((entry) => JSON.stringify(entry)).join("\n")),
        block("memory_doc", truncateText(input.memory, input.config.context.maxMemoryChars).text),
        input.soul !== undefined
          ? block("soul_doc", truncateText(input.soul, input.config.context.maxUserProfileChars).text)
          : undefined,
        input.group !== undefined
          ? block("group_doc", truncateText(input.group, input.config.context.maxUserProfileChars).text)
          : undefined,
        buildUserDocsBlock(input.userFiles, input.config.context.maxUserProfileChars),
      ),
    },
  ];
}

export async function buildDreamPhase2Context(
  input: DreamContextInput,
  phase1Analysis: string,
): Promise<AgentContextMessage[]> {
  const [agents, skills] = await Promise.all([
    readFile(input.agentsPath, "utf8"),
    new SkillLoader(input.workspaceRoot).load(["memory", "workspace-files"]),
  ]);

  return [
    {
      role: "system",
      content: sections(
        `You are executing memory file edits based on the analysis.
Apply [FILE], [FILE-REMOVE], and [SKILL] entries using workspace file tools.
Surgical edits only — never rewrite entire files.

Editing rules:
- [FILE] → add the atomic fact to the relevant section of the target file
- [FILE-REMOVE] → find the described content and delete it from the file
- [SKILL] → create skills/<name>/SKILL.md with YAML frontmatter (name, description fields). Skip if name already in existing_skills.
- Files below contain current content — use exact strings for old_text matching
- Batch changes to the same file into one workspace_write call`,
        block("instructions", agents),
        block("skills", skills.map((skill) => skill.body).join("\n\n")),
        block("guardrails", memoryGuardrails),
        block(
          "scope",
          JSON.stringify(
            {
              reason: input.reason,
              maxIterations: input.config.memory.dream.maxIterations,
              allowEditSoul: input.config.memory.dream.allowEditSoul,
              allowEditGroup: input.config.memory.dream.allowEditGroup,
              allowEditUserProfiles: input.config.memory.dream.allowEditUserProfiles,
            },
            null,
            2,
          ),
        ),
      ),
    },
    {
      role: "user",
      content: sections(
        block("analysis", phase1Analysis),
        block("memory_doc", truncateText(input.memory, input.config.context.maxMemoryChars).text),
        input.soul !== undefined
          ? block("soul_doc", truncateText(input.soul, input.config.context.maxUserProfileChars).text)
          : undefined,
        input.group !== undefined
          ? block("group_doc", truncateText(input.group, input.config.context.maxUserProfileChars).text)
          : undefined,
        buildUserDocsBlock(input.userFiles, input.config.context.maxUserProfileChars),
        input.existingSkillNames.length > 0
          ? block("existing_skills", input.existingSkillNames.join("\n"))
          : undefined,
      ),
    },
  ];
}

function formatHistoryEntries(history: HistoryEntry[]): string {
  return history
    .map((entry) => {
      const participants =
        entry.participants.length > 0 ? ` [participants: ${entry.participants.join(", ")}]` : "";
      return `[${entry.time}]${participants} ${entry.summary}`;
    })
    .join("\n");
}

function buildUserDocsBlock(userFiles: Map<string, string>, maxCharsPerFile: number): string | undefined {
  if (userFiles.size === 0) return undefined;
  const parts = [...userFiles.entries()].map(([filePath, content]) => {
    const trimmed = truncateText(content, maxCharsPerFile).text.trim();
    return `<user_doc path="${filePath}">\n${trimmed}\n</user_doc>`;
  });
  return `<user_docs>\n${parts.join("\n")}\n</user_docs>`;
}

const memoryGuardrails = `Only preserve information that is likely to remain useful later.

Do not add or update durable memory for one-off jokes, temporary tests, simple thanks, acknowledgements, transient debugging logs, or ordinary small talk unless the user explicitly asks to remember it.`;
