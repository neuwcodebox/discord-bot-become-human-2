---
name: skill-creator
description: Create or improve skills in the guild workspace. Use when a user asks you to save a new capability, workflow, or reusable instruction set as a skill, or wants to update an existing skill's description or body.
---

# Skill Creator

## Directory Structure
Each skill lives at `skills/<skill-name>/SKILL.md` inside the current guild workspace.

## Required Frontmatter
Every SKILL.md must have YAML frontmatter with at least `name` and `description`:

```yaml
---
name: my-skill
description: One sentence describing when to use this skill and what it does.
---
```

Add `always: true` only for skills that should always be loaded (e.g. memory).

## Creation Workflow
1. Confirm the skill name and description with the user before writing.
2. Write the file to `skills/<skill-name>/SKILL.md` using `workspace_write`.
3. Keep the body concise: list tools, paths, and constraints needed to execute the skill.

## Restrictions
Only create or edit skills under `skills/` in the current guild workspace.
Do not modify repo templates, `SOUL.md`, `GROUP.md`, `TOOLS.md`, or `resources/AGENTS.md`.
