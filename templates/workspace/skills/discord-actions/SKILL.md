---
name: discord-actions
description: Perform lightweight Discord interactions. Use when you need to react or unreact to a message, edit or delete a bot-owned message, look up a guild member's display name or roles, or check current channel metadata.
---

# Discord Actions

## Allowed Operations
- `discord_react` — add an emoji reaction to any message
- `discord_unreact` — remove this bot's emoji reaction from a message
- `discord_edit_own` — edit a message this bot previously sent
- `discord_delete_own` — delete a message this bot previously sent
- `discord_get_member` — read public guild member metadata (display name, roles, joined at)
- `discord_get_channel` — read current channel metadata (name, topic, type)

## Restrictions
Do not attempt moderation, bans, kicks, role assignment, or any administrative action.
Only edit or delete messages that this bot itself sent.
