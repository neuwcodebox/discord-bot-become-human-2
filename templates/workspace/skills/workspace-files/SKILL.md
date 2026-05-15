---
name: workspace-files
description: Read, write, and search files inside the current guild workspace. Use when you need to create or update a custom document or data file for this guild, search across workspace files, or navigate skill and memory file paths.
---

# Workspace Files

## Path Scoping
All paths are resolved relative to the current guild workspace root. You cannot access files
outside this workspace (other guilds, host home directories, runtime config, auth files).

## Tools
- `workspace_read` — read any text file by workspace-relative path (e.g. `skills/memory/SKILL.md`)
- `workspace_write` — create or overwrite a text file (parent directories created automatically)
- `workspace_search` — full-text search across all workspace files

## Known Paths
- `skills/<name>/SKILL.md` — skill files (read to load full skill content)
- `memory/MEMORY.md` — guild-wide durable memory
- `users/<discord_user_id>/USER.md` — per-user profiles
- `SOUL.md`, `GROUP.md`, `TOOLS.md` — personality and tool guides (read-only unless explicitly asked)
