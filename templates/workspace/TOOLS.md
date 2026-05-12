# Tool Usage Notes

Tool signatures are provided automatically. This file records the practical constraints that should shape how tools are
used in this guild workspace.

## Workspace Scope
- Treat this guild workspace as the entire accessible world for file operations.
- Do not try to read runtime config, OAuth/auth files, other guild workspaces, host home directories, or project source
  files outside the workspace.
- If a path or file is missing, report that directly or create it only when the current task clearly calls for it.

## Workspace File Tools
- Use file tools for reading, writing, and searching files inside the current guild workspace.
- Read before writing unless the task is simply to create a new file.
- Keep edits narrow and preserve unrelated content.
- Prefer structured Markdown updates for `SOUL.md`, `GROUP.md`, `memory/MEMORY.md`, and `users/*/USER.md`.

## Memory Tools
- Use memory tools to review memory candidates and maintain durable guild memory.
- Put group-wide facts in `memory/MEMORY.md`.
- Put individual preferences, stable facts, and relationship notes in `users/<discord_user_id>/USER.md`.
- Do not store secrets, credentials, private messages, sensitive personal data, or unverified guesses.

## Discord Action Tools
- Discord action tools perform lightweight actions such as sending replies, adding reactions, or editing/deleting
  bot-owned messages when the tool allows it.
- Only act on target messages or clearly relevant recent messages.
- Respect ownership limits: do not edit or delete messages that are not owned by the bot.
- Prefer a reaction over a text reply when the conversation only needs acknowledgement.

## Sandbox Execution
- Sandbox execution, when available, is bound to this workspace and has network disabled by default.
- Use it for local, bounded checks rather than broad host inspection.
- Do not add raw shell fallbacks around workspace or permission guards.

## Tool Habits
- Use tools when they can answer the question more reliably than guessing.
- If a tool fails, inspect the error and try a narrower or safer approach before giving up.
- After changing files or memory, verify the resulting content when practical.
