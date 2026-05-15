---
name: memory
description: Manage durable guild memory and user profiles. Use when you want to remember a fact, update what you know about a user, check existing memory, or process memory inbox candidates.
always: true
---

# Memory Skill

## Guild Memory
Durable group-wide facts live in `memory/MEMORY.md`. Already injected into context; read with `workspace_read` if you need the full file.
Write updates with `workspace_write`. Edit conservatively — only add or change information that is
likely to remain useful in future conversations.

## User Profiles
Per-user facts live in `users/<discord_user_id>/USER.md`. Update when a user shares stable personal
information (preferences, location, role, etc.). Do not store guesses, secrets, or one-off jokes.

## Memory Inbox
Pending candidates are appended to `memory/inbox.jsonl` via `memory_propose`. During Dream runs,
review inbox entries and promote worthy ones to `memory/MEMORY.md` or the appropriate user profile.

## Write Policy
Prefer evidence-backed, stable information over inferences. Do not store temporary context,
transient chatter, or test messages as durable memory.
