# discord-bot-become-human-2

An AI agent bot that reads the full context of Discord group chat like a person would, then naturally joins in when the moment calls for it.
Each server gets an isolated workspace that keeps the bot's identity, long-term memory, and skills in text files, while OpenAI Codex or OpenAI-compatible LLMs and sandboxed tool execution extend its conversations and actions.

---

## Requirements

- Node.js 24+
- A Discord bot account (create one at the Developer Portal)
- OpenAI Codex account — or any OpenAI-compatible endpoint (OpenAI, OpenRouter, local models, etc.)
- bubblewrap (`bwrap`) — required for sandboxed code execution, Linux only (only needed when `sandbox.enabled: true`)

```bash
# Debian/Ubuntu
sudo apt install bubblewrap

# Arch
sudo pacman -S bubblewrap

# Fedora
sudo dnf install bubblewrap
```

On Windows or environments where bwrap is unavailable, set `sandbox.enabled: false` in `config.json` to run without bwrap. Note that OS-level isolation is not provided in this mode — use it only in trusted environments.

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

## config.json Reference

On first run the bot creates `~/.discord-bot-become-human-2/config.json` with defaults.

### discord

| Key | Default | Description |
|---|---|---|
| `tokenEnv` | `"DISCORD_BOT_TOKEN"` | Environment variable name holding the bot token |
| `allowedGuildIds` | `[]` | Allowed server IDs. Empty means all servers |
| `allowedChannelIds` | `[]` | Allowed channel IDs. Empty means all channels |
| `adminUserIds` | `[]` | User IDs allowed to use admin commands (`/compact`, `/dream`) |
| `enableMentions` | `true` | React to bot mentions |
| `enableReplies` | `true` | React when someone replies to the bot's message |
| `enableReactions` | `true` | Allow emoji reaction responses |
| `enableMessageEditStreaming` | `true` | Stream responses by progressively editing a message |

### llm

Choose one of two providers.

**OpenAI Codex:**

```json
{
  "llm": {
    "provider": "openai-codex",
    "model": "gpt-5.5",
    "reasoning": "medium",
    "codex": {
      "authPath": "~/.discord-bot-become-human-2/codex-auth.json",
      "transport": "auto"
    }
  }
}
```

- `reasoning`: `"low"` / `"medium"` / `"high"` / `"xhigh"`
- `transport`: `"auto"` / `"responses"` / `"websocket"`

**OpenAI-compatible endpoint:**

```json
{
  "llm": {
    "provider": "openai-compatible",
    "model": "gpt-5.5",
    "baseURL": "https://api.openai.com/v1",
    "apiKeyEnv": "OPENAI_API_KEY",
    "contextWindow": 128000,
    "reasoning": "medium"
  }
}
```

- `apiKeyEnv`: environment variable name holding the API key
- `contextWindow`: model context window size in tokens

### runtime

| Key | Default | Description |
|---|---|---|
| `rootDir` | `"~/.discord-bot-become-human-2"` | Root directory for all runtime data |
| `defaultLocale` | `"ko-KR"` | Default locale for bot output |
| `timezone` | `"Asia/Seoul"` | Timezone used in time expressions |

### conversation

**Top-level**

| Key | Default | Description |
|---|---|---|
| `maxRecentMessages` | `100` | Number of recent events included in context |
| `maxParticipantsForProfileLoad` | `16` | Maximum user profiles loaded at once |
| `cooldownMs` | `[10000, 30000]` | Cooldown range after each reply (ms), picked randomly |

**`notEngaged` — conditions for entering a conversation**

| Key | Default | Description |
|---|---|---|
| `directTriggerDebounceMs` | `[0, 1000]` | Delay before replying to a direct trigger (mention, name, reply, slash command) (ms) |
| `ambientDebounceMs` | `[3000, 9000]` | Delay before replying after ambient engagement (ms) |
| `ambientEngagementEnabled` | `true` | Whether the bot can join conversations without a direct trigger |
| `ambientMinSilenceMs` | `300000` | Minimum silence since last human message before ambient engagement is tried (ms, default 5 min) |
| `ambientDecisionCooldownMs` | `900000` | Minimum interval between ambient engagement decision LLM calls (ms, default 15 min) |
| `ambientConfidenceThreshold` | `0.78` | Minimum LLM confidence required for ambient engagement |
| `ambientMaxPerHour` | `2` | Maximum ambient engagements per hour |

**`engaged` — response conditions while engaged**

| Key | Default | Description |
|---|---|---|
| `minSecondsBetweenBotReplies` | `20` | Minimum seconds between consecutive bot replies |
| `minSecondsBetweenUnpromptedReplies` | `90` | Minimum seconds between unprompted bot replies |
| `maxConsecutiveBotReplies` | `1` | Max bot replies without an intervening human message |
| `replyConfidenceThreshold` | `0.7` | Minimum LLM confidence required to send a reply |
| `silentStayConfidenceThreshold` | `0.55` | Minimum LLM confidence required to send an emoji reaction |
| `disengageAfterUnrelatedHumanMessages` | `8` | Disengage after this many human messages unrelated to the bot |
| `disengageAfterIdleMs` | `900000` | Disengage after this much silence since the last human message (ms, default 15 min) |

**`engaged.followUpBatch` — message batching while engaged**

| Key | Default | Description |
|---|---|---|
| `directTriggerDebounceMs` | `[1000, 2000]` | Wait range before flushing when a direct trigger is present (ms) |
| `quietDebounceMs` | `[3000, 5000]` | Wait range before flushing for ordinary messages (ms) |
| `maxWaitMs` | `15000` | Maximum wait before a forced flush (ms) |
| `maxMessages` | `4` | Flush immediately when this many messages are pending |

### memory

**compaction — event log archiving**

| Key | Default | Description |
|---|---|---|
| `enabled` | `true` | Enable event log compaction |
| `maxEventsBeforeCompaction` | `120` | Compact when the event count exceeds this |
| `minEventsPerSummary` | `20` | Minimum events included in each compaction pass |

**dream — long-term memory updates**

| Key | Default | Description |
|---|---|---|
| `enabled` | `true` | Enable Dream runs |
| `intervalMinutes` | `120` | Minimum interval between Dream runs (minutes) |
| `runOnConversationEnd` | `true` | Run Dream when a conversation ends |
| `runOnCompaction` | `true` | Run Dream after compaction |
| `allowEditSoul` | `true` | Whether Dream can edit SOUL.md |
| `allowEditGroup` | `true` | Whether Dream can edit GROUP.md |
| `allowEditUserProfiles` | `true` | Whether Dream can edit user profiles |

### tools

Toggles for each tool available to the bot. All default to `true`.

| Key | Description |
|---|---|
| `workspaceFiles` | Read and write workspace files |
| `memory` | Read and write memory |
| `discordActions` | Send, edit, delete messages and add reactions |
| `fetchUrl` | Fetch URL content |
| `readAttachment` | Read message attachments |
| `sandboxExec` | Execute code in a sandbox |
| `searchInternet` | Search the web (also requires `search` config) |

### sandbox

| Key | Default | Description |
|---|---|---|
| `enabled` | `true` | `true`: OS-level isolation via bwrap. `false`: direct execution without bwrap (cwd fixed, env sanitized, shell interpreters blocked — no OS isolation, not recommended) |
| `network` | `true` | Allow network access inside the sandbox (only effective when `enabled: true`) |
| `timeoutMs` | `30000` | Maximum sandbox execution time (ms) |
| `outputLimitBytes` | `131072` | Maximum sandbox output size (bytes) |

### search (optional)

Required for `tools.searchInternet` to work.

```json
{
  "search": {
    "provider": "tavily",
    "apiKey": "tvly-..."
  }
}
```

### observability (optional)

Trace LLM calls with [Langfuse](https://langfuse.com).

```json
{
  "observability": {
    "langfuse": {
      "publicKeyEnv": "LANGFUSE_PUBLIC_KEY",
      "secretKeyEnv": "LANGFUSE_SECRET_KEY",
      "host": "https://cloud.langfuse.com"
    }
  }
}
```

Add the keys to `.env`:

```env
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
```

---

## Docker Deployment

### Run

```bash
docker run -d \
  --name bot \
  --restart unless-stopped \
  --env-file .env \
  -v bot-data:/root/.discord-bot-become-human-2 \
  neurowhai/discord-bot-become-human-2:latest
```

To build the image yourself:

```bash
docker build -t discord-bot-become-human-2 .
```

Bot data (config.json, codex-auth.json, guild workspaces) is persisted in the `bot-data` named volume.

### Initial Setup

On first run, `config.json` is created with defaults. To edit it:

```bash
docker exec -it bot sh -c 'cat /root/.discord-bot-become-human-2/config.json'
# edit the file on the host via the volume, then restart:
docker restart bot
```

Config is read once at startup — restart the container after any change.

### Codex Login (if using openai-codex)

```bash
docker run --rm -it \
  -v bot-data:/root/.discord-bot-become-human-2 \
  neurowhai/discord-bot-become-human-2:latest \
  node dist/scripts/login-openai-codex.mjs
```

### Logs

```bash
docker logs -f bot
```

For structured JSON logs add to your env file:

```env
LOG_FORMAT=json
```

### bwrap Sandbox

`bwrap` is installed setuid in the image so the sandbox works without `--privileged`. If user namespaces are restricted on your host, add `--security-opt seccomp=unconfined`.

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
