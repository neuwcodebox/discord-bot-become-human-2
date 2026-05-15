# discord-bot-become-human-2

An AI agent bot that participates naturally in Discord group chat. Instead of responding only to commands, it watches the conversation and joins in when the moment feels right.

You can configure the bot's name, personality, tone, and role through text files. Each Discord server gets its own independent setup.

---

## Requirements

- Node.js 24+
- A Discord bot account (create one at the Developer Portal)
- OpenAI Codex account — or any OpenAI-compatible endpoint (OpenAI, OpenRouter, local models, etc.)
- bubblewrap (`bwrap`) — required for sandboxed code execution, Linux only

```bash
# Debian/Ubuntu
sudo apt install bubblewrap

# Arch
sudo pacman -S bubblewrap

# Fedora
sudo dnf install bubblewrap
```

---

## Installation

```bash
git clone <repo>
cd discord-bot-become-human-2
npm install
```

---

## Setup

### 1. Discord Bot Token

Create a bot at the [Discord Developer Portal](https://discord.com/developers/applications) and get a token.

Create a `.env` file in the project root:

```env
DISCORD_BOT_TOKEN=your_bot_token_here
```

Required permissions when inviting the bot:
- View Channel, Send Messages, Read Message History, Add Reactions

Required Gateway Intents (enable under Developer Portal > Bot):
- Message Content Intent
- Server Members Intent (optional, improves user profile quality)

### 2. LLM Connection

**Using OpenAI Codex:**

```bash
npm run login:codex
```

A browser window will open for login. Credentials are saved automatically when done.

**Using OpenAI API or another compatible endpoint:**

Run the bot once to generate `~/.discord-bot-become-human-2/config.json`, then edit the `llm` section:

```json
{
  "llm": {
    "provider": "openai-compatible",
    "model": "gpt-5.5",
    "baseURL": "https://api.openai.com/v1",
    "apiKeyEnv": "OPENAI_API_KEY",
    "contextWindow": 128000
  }
}
```

Add the API key to `.env`:

```env
OPENAI_API_KEY=your_api_key_here
```

### 3. Run

```bash
npm run dev
```

On first run, a workspace folder is automatically created for each server the bot is in.

---

## Bot Personality Setup

The bot's personality and behavior are configured through text files. Files are separated per server, so the bot can feel different in each one.

Config file location:

```
~/.discord-bot-become-human-2/guilds/<server_id>/workspace/
```

### SOUL.md — Bot Identity

Defines the bot's name, personality, speaking style, and boundaries.

```markdown
## Identity
- Name / nickname: your bot's name
- Role in this server: what the bot is here for

## Personality
- Default tone: casual and light
- Humor style: gentle humor, no forced jokes

## Speaking Style
- Preferred language(s): English
- Default response length: short and to the point

## Boundaries
- Don't engage with private DMs or sensitive personal topics
```

### GROUP.md — Server Context

Describes the server's vibe and norms. The bot uses this to decide when to join a conversation.

```markdown
## What this server is
- Server purpose: developer study group
- Languages commonly used: English

## Social Norms
- How casual or formal people are: casual, friends
- How much bot participation is usually welcome: moderate, don't jump in too often
```

---

## How the Bot Joins Conversations

The bot responds in three ways:

1. **Direct invocation** — when mentioned, replied to, or called by name
2. **Ambient participation** — joins on its own when the topic and mood feel right (configurable via GROUP.md)
3. **Reactions** — adds an emoji reaction instead of sending a message

The bot won't respond to everything. If the conversation is flowing well without it, staying quiet is the default.

---

## Memory

The bot remembers conversations. Server-wide memory and per-user memory are managed separately.

- **Server memory** — stored in `workspace/memory/MEMORY.md`. You can edit this directly to give the bot information upfront.
- **User memory** — stored in `workspace/users/<user_id>/USER.md`. Filled in automatically through conversation.
- Memory is isolated per server. The same user is treated independently in each server.

---

## Adding Skills

To extend the bot's capabilities, add a skill folder under `workspace/skills/`:

```
workspace/skills/
  my-skill/
    SKILL.md
```

Example `SKILL.md`:

```markdown
---
name: my-skill
description: When to use this skill — e.g. "Use this skill when the user asks about X"
---

This skill is used when ...

## Instructions
- ...
```

You can also just tell the bot in chat to "create a new skill" — it will write the skill file itself.

Built-in skills: `memory`, `skill-creator`, `weather`, `workspace-files`, `discord-actions`

---

## Restricting to Specific Servers or Channels

By default the bot works in all servers and channels it has access to. To restrict it, edit `config.json`:

```json
{
  "discord": {
    "allowedGuildIds": ["server_id_1", "server_id_2"],
    "allowedChannelIds": ["channel_id_1"]
  }
}
```

---

## Development Commands

```bash
npm run dev       # run the bot
npm run build     # build
npm test          # run tests
npm run check     # type check
npm run lint      # lint
```

Adjust log level:

```bash
LOG_LEVEL=debug npm run dev
```

---

## Runtime File Structure

All data is stored under `~/.discord-bot-become-human-2/`.

```
~/.discord-bot-become-human-2/
  config.json
  codex-auth.json

  guilds/
    <server_id>/
      workspace/
        SOUL.md
        GROUP.md
        TOOLS.md
        memory/
          MEMORY.md       # server-wide long-term memory
          events.jsonl    # Discord event log
          history.jsonl   # compacted conversation archive
        users/
          <user_id>/
            USER.md       # user profile
        skills/           # server-specific skills
```

`config.json` and `codex-auth.json` are never exposed to the bot agent. The agent can only read and write files inside the current server's workspace.

---

## Tech Stack

- **Node.js / TypeScript**
- **discord.js** — Discord event handling and message delivery
- **pi agent harness** (`@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`) — ReAct-style agent execution
- **bwrap** — sandbox isolation for code execution (Linux)

---

## Acknowledgements

- [pi](https://github.com/earendil-works/pi) — agent execution core and OpenAI Codex provider
- [nanobot](https://github.com/HKUDS/nanobot) — inspiration for workspace-based long-term memory, Dream memory lifecycle, and skill structure
