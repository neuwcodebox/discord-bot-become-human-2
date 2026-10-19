# Tool Usage Notes

Tool signatures are provided automatically. This file records the practical constraints that should shape how tools are
used in this guild workspace.

## Workspace Scope
- Treat this guild workspace as the entire accessible world for file operations.
- Do not access files outside this workspace or seek credentials or other guilds' files.
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
- Use command execution only for bounded work in this workspace, not host inspection.
- Respect the access limits of the available tool; do not try to bypass them through another command.
- If a task requires unavailable access, explain the limitation.

## Tool Habits
- Use tools when they can answer the question more reliably than guessing.
- If a tool fails, inspect the error and try a narrower or safer approach before giving up.
- After changing files or memory, verify the resulting content when practical.
