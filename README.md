# discord-bot-become-human-2

[English](README.en.md)

Discord 그룹 채팅의 전체 맥락을 사람처럼 읽고 필요한 순간에 자연스럽게 끼어드는 AI 에이전트 봇입니다.
서버별 workspace는 봇의 정체성, 장기 기억, 스킬을 텍스트 파일로 담아 두며, OpenAI Codex 또는 OpenAI 호환 LLM과 샌드박스 도구 실행으로 대화와 작업을 확장합니다.

---

## 요구사항

- Node.js 24 이상
- Discord 봇 계정 (Developer Portal에서 생성)
- OpenAI Codex 계정 — 또는 OpenAI API 호환 엔드포인트 (OpenAI, OpenRouter, 로컬 모델 등)
- bubblewrap (`bwrap`) — 코드 샌드박스 실행용, Linux 필요

```bash
# Debian/Ubuntu
sudo apt install bubblewrap

# Arch
sudo pacman -S bubblewrap

# Fedora
sudo dnf install bubblewrap
```

---

## 설치

```bash
git clone <repo>
cd discord-bot-become-human-2
npm install
```

---

## 설정

### 1. Discord 봇 토큰

[Discord Developer Portal](https://discord.com/developers/applications)에서 봇을 만들고 토큰을 발급받습니다.

프로젝트 루트에 `.env` 파일을 만들고 토큰을 넣습니다:

```env
DISCORD_BOT_TOKEN=여기에_봇_토큰
```

봇 초대 시 필요한 권한:
- View Channel, Send Messages, Read Message History, Add Reactions

필요한 Gateway Intents (Developer Portal > Bot 탭에서 활성화):
- Message Content Intent
- Server Members Intent (선택, 사용자 프로필 품질 향상용)

### 2. LLM 연결

**OpenAI Codex를 사용한다면:**

```bash
npm run login:codex
```

브라우저 창이 열리면 로그인합니다. 완료되면 인증 정보가 자동으로 저장됩니다.

**OpenAI API나 다른 호환 엔드포인트를 사용한다면:**

봇을 처음 실행하면 `~/.discord-bot-become-human-2/config.json`이 생성됩니다. 그 안의 `llm` 항목을 수정합니다:

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

`.env`에 API 키도 추가합니다:

```env
OPENAI_API_KEY=여기에_API_키
```

### 3. 실행

```bash
npm run dev
```

처음 실행하면 봇이 들어있는 서버마다 설정 폴더가 자동으로 만들어집니다.

---

## 봇 성격 설정

봇의 성격과 동작 방식은 텍스트 파일로 설정합니다. 파일은 서버별로 분리되어 있어서 서버마다 다른 봇처럼 운영할 수 있습니다.

설정 파일 위치:

```
~/.discord-bot-become-human-2/guilds/<서버ID>/workspace/
```

### SOUL.md — 봇의 정체성

봇의 이름, 성격, 말투, 해서는 안 되는 행동을 정의합니다.

```markdown
## Identity
- Name / nickname: 봇 이름이나 닉네임
- Role in this server: 이 서버에서 맡은 역할

## Personality
- Default tone: 친근하고 가볍게
- Humor style: 유머는 적당히, 억지로 웃기려 하지 않기

## Speaking Style
- Preferred language(s): 한국어
- Default response length: 짧고 간결하게

## Boundaries
- 개인 DM 내용이나 민감한 주제는 다루지 않기
```

### GROUP.md — 서버 분위기

이 서버가 어떤 곳인지, 어떤 분위기인지 알려줍니다. 봇이 대화에 끼어들 타이밍을 잡을 때 참고합니다.

```markdown
## What this server is
- Server purpose: 개발자들이 모인 스터디 서버
- Languages commonly used: 한국어

## Social Norms
- How casual or formal people are: 친한 사이, 반말 사용
- How much bot participation is usually welcome: 적당히, 너무 자주 끼어들지 않기
```

---

## 봇이 대화에 참여하는 방식

봇은 세 가지 경우에 반응합니다:

1. **직접 호출** — 봇을 멘션하거나, 봇 메시지에 답장하거나, 봇 이름을 부를 때
2. **자발적 참여** — 대화 주제와 분위기가 맞을 때 스스로 끼어듦 (GROUP.md 설정에 따라 조절 가능)
3. **반응** — 말로 답하는 대신 이모지 반응으로 참여

대화 중간에 말을 걸지 않을 때도 있습니다. 이미 대화가 잘 흘러가고 있으면 조용히 지켜보는 게 기본 동작입니다.

---

## 기억

봇은 대화 내용을 기억합니다. 서버 전체에 대한 기억과 사용자 개인에 대한 기억을 따로 관리합니다.

- **서버 기억** — `workspace/memory/MEMORY.md`에 저장됩니다. 직접 편집해서 봇이 알아야 할 정보를 미리 넣어둘 수 있습니다.
- **사용자 기억** — `workspace/users/<사용자ID>/USER.md`에 저장됩니다. 대화를 통해 자동으로 채워집니다.
- 기억은 서버별로 분리됩니다. 같은 사용자라도 다른 서버에서는 처음 만난 사람처럼 대합니다.

---

## 스킬 추가

봇의 기능을 확장하고 싶다면 `workspace/skills/` 아래에 스킬 폴더를 만들 수 있습니다.

```
workspace/skills/
  my-skill/
    SKILL.md
```

`SKILL.md` 예시:

```markdown
---
name: my-skill
description: 언제 이 스킬을 써야 하는지 — 예: "Use this skill when the user asks about X"
---

이 스킬은 ... 할 때 사용합니다.

## 지침
- ...
```

봇에게 채팅으로 "새 스킬 만들어줘"라고 해도 됩니다. 봇이 직접 스킬 파일을 작성합니다.

기본 내장 스킬: `memory`, `skill-creator`, `weather`, `workspace-files`, `discord-actions`

---

## config.json 설정 항목

봇을 처음 실행하면 `~/.discord-bot-become-human-2/config.json`이 기본값으로 생성됩니다.

### discord

| 항목 | 기본값 | 설명 |
|---|---|---|
| `tokenEnv` | `"DISCORD_BOT_TOKEN"` | 봇 토큰을 읽어올 환경 변수 이름 |
| `allowedGuildIds` | `[]` | 허용할 서버 ID 목록. 비워두면 모든 서버에서 동작 |
| `allowedChannelIds` | `[]` | 허용할 채널 ID 목록. 비워두면 모든 채널에서 동작 |
| `adminUserIds` | `[]` | `/compact`, `/dream` 등 관리자 명령어를 사용할 수 있는 사용자 ID 목록 |
| `enableMentions` | `true` | 봇 멘션 반응 활성화 |
| `enableReplies` | `true` | 봇 메시지 답장 반응 활성화 |
| `enableReactions` | `true` | 이모지 반응 기능 활성화 |
| `enableMessageEditStreaming` | `true` | 스트리밍 답변 활성화 (메시지를 점진적으로 편집하며 출력) |

### llm

두 가지 provider 중 하나를 선택합니다.

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

**OpenAI 호환 엔드포인트:**

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

- `apiKeyEnv`: API 키를 읽어올 환경 변수 이름
- `contextWindow`: 모델의 컨텍스트 윈도우 크기 (토큰 수)

### runtime

| 항목 | 기본값 | 설명 |
|---|---|---|
| `rootDir` | `"~/.discord-bot-become-human-2"` | 런타임 데이터 저장 루트 경로 |
| `defaultLocale` | `"ko-KR"` | 봇이 사용할 기본 언어 |
| `timezone` | `"Asia/Seoul"` | 봇이 시간 표현에 사용할 타임존 |

### conversation

**기본값**

| 항목 | 기본값 | 설명 |
|---|---|---|
| `maxRecentMessages` | `100` | 컨텍스트에 포함할 최근 이벤트 수 |
| `maxParticipantsForProfileLoad` | `16` | 한 번에 로드할 최대 사용자 프로필 수 |
| `cooldownMs` | `[10000, 30000]` | 답변 후 쿨다운 시간 범위 (ms). 범위 안에서 무작위 선택 |

**`notEngaged` — 비참여 상태에서 참여 진입 조건**

| 항목 | 기본값 | 설명 |
|---|---|---|
| `directTriggerDebounceMs` | `[0, 1000]` | 멘션·이름·답글·슬래시 등 직접 트리거 후 응답까지 지연 범위 (ms) |
| `ambientDebounceMs` | `[3000, 9000]` | 앰비언트 참여 후 응답까지 지연 범위 (ms) |
| `ambientEngagementEnabled` | `true` | 직접 트리거 없이 자발적으로 대화에 참여할지 여부 |
| `ambientMinSilenceMs` | `300000` | 앰비언트 참여를 시도하기 위한 최소 침묵 시간 (ms, 기본 5분) |
| `ambientConfidenceThreshold` | `0.78` | 앰비언트 참여를 결정하는 LLM 신뢰도 최솟값 |
| `ambientMaxPerHour` | `2` | 시간당 최대 앰비언트 참여 횟수 |

**`engaged` — 참여 중 상태에서 응답 조건**

| 항목 | 기본값 | 설명 |
|---|---|---|
| `minSecondsBetweenBotReplies` | `20` | 연속 응답 사이 최소 간격 (초) |
| `minSecondsBetweenUnpromptedReplies` | `90` | 자발적 응답 사이 최소 간격 (초) |
| `maxConsecutiveBotReplies` | `1` | 사람 메시지 없이 연속으로 보낼 수 있는 최대 답변 수 |
| `replyConfidenceThreshold` | `0.7` | 응답하기 위한 LLM 신뢰도 최솟값 |
| `silentStayConfidenceThreshold` | `0.55` | 이모지 반응하기 위한 LLM 신뢰도 최솟값 |
| `disengageAfterUnrelatedHumanMessages` | `8` | 봇과 무관한 사람 메시지가 이 수에 도달하면 참여 종료 |
| `disengageAfterIdleMs` | `900000` | 마지막 사람 메시지로부터 이 시간이 지나면 참여 종료 (ms, 기본 15분) |

**`engaged.followUpBatch` — 참여 중 메시지 묶음 처리**

| 항목 | 기본값 | 설명 |
|---|---|---|
| `directTriggerDebounceMs` | `[1000, 2000]` | 직접 트리거 메시지가 있을 때 flush 전 대기 범위 (ms) |
| `quietDebounceMs` | `[3000, 5000]` | 일반 메시지일 때 flush 전 대기 범위 (ms) |
| `maxWaitMs` | `15000` | 최대 대기 시간. 이 시간이 지나면 강제로 flush (ms) |
| `maxMessages` | `4` | 이 수를 초과하면 즉시 flush |

### memory

**compaction — 이벤트 로그 압축**

| 항목 | 기본값 | 설명 |
|---|---|---|
| `enabled` | `true` | 이벤트 로그 압축 활성화 |
| `maxEventsBeforeCompaction` | `120` | 이 이벤트 수를 초과하면 오래된 것을 압축 |
| `minEventsPerSummary` | `20` | 한 번 압축할 때 최소 포함 이벤트 수 |

**dream — 장기 기억 업데이트**

| 항목 | 기본값 | 설명 |
|---|---|---|
| `enabled` | `true` | Dream 실행 활성화 |
| `intervalMinutes` | `120` | Dream 실행 최소 간격 (분) |
| `runOnConversationEnd` | `true` | 대화 종료 후 Dream 실행 여부 |
| `runOnCompaction` | `true` | 압축 후 Dream 실행 여부 |
| `allowEditSoul` | `true` | Dream이 SOUL.md를 편집할 수 있는지 여부 |
| `allowEditGroup` | `true` | Dream이 GROUP.md를 편집할 수 있는지 여부 |
| `allowEditUserProfiles` | `true` | Dream이 사용자 프로필을 편집할 수 있는지 여부 |

### tools

봇이 사용할 수 있는 도구를 켜고 끕니다. 모두 기본값 `true`.

| 항목 | 설명 |
|---|---|
| `workspaceFiles` | workspace 파일 읽기·쓰기 |
| `memory` | 기억 읽기·쓰기 |
| `discordActions` | Discord 메시지 전송·수정·삭제·반응 |
| `fetchUrl` | URL 내용 가져오기 |
| `readAttachment` | 메시지 첨부 파일 읽기 |
| `sandboxExec` | 샌드박스 코드 실행 |
| `searchInternet` | 인터넷 검색 (`search` 설정도 필요) |

### sandbox

| 항목 | 기본값 | 설명 |
|---|---|---|
| `enabled` | `true` | bwrap 샌드박스 격리 활성화 |
| `network` | `true` | 샌드박스 내 네트워크 허용 |
| `timeoutMs` | `30000` | 샌드박스 실행 최대 시간 (ms) |
| `outputLimitBytes` | `131072` | 샌드박스 출력 최대 크기 (bytes) |

### search (선택)

인터넷 검색 기능에 사용할 검색 API를 설정합니다. `tools.searchInternet`이 `true`여야 동작합니다.

```json
{
  "search": {
    "provider": "tavily",
    "apiKey": "tvly-..."
  }
}
```

### observability (선택)

LLM 호출을 [Langfuse](https://langfuse.com)로 추적합니다.

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

환경 변수에 키를 넣습니다:

```env
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
```

---

## 개발 명령어

```bash
npm run dev       # 봇 실행
npm run build     # 빌드
npm test          # 테스트
npm run check     # 타입 체크
npm run lint      # 린트
```

로그 레벨 조절:

```bash
LOG_LEVEL=debug npm run dev
```

---

## 런타임 파일 구조

모든 데이터는 `~/.discord-bot-become-human-2/` 아래에 저장됩니다.

```
~/.discord-bot-become-human-2/
  config.json
  codex-auth.json

  guilds/
    <서버ID>/
      workspace/
        SOUL.md
        GROUP.md
        TOOLS.md
        memory/
          MEMORY.md       # 서버 장기 기억
          events.jsonl    # Discord 이벤트 로그
          history.jsonl   # 대화 압축 아카이브
        users/
          <사용자ID>/
            USER.md       # 사용자 프로필
        skills/           # 서버별 스킬
```

`config.json`과 `codex-auth.json`은 봇 에이전트에게 노출되지 않습니다. 에이전트는 현재 서버의 workspace 안에서만 파일을 읽고 쓸 수 있습니다.

---

## 기술 스택

- **Node.js / TypeScript**
- **discord.js** — Discord 이벤트 수신 및 메시지 전송
- **pi agent harness** (`@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`) — ReAct 스타일 에이전트 실행
- **bwrap** — 샌드박스 실행 격리 (Linux)

---

## 참고한 프로젝트

- [pi](https://github.com/earendil-works/pi) — 에이전트 실행 코어 및 OpenAI Codex provider
- [nanobot](https://github.com/HKUDS/nanobot) — workspace 기반 장기 기억, Dream memory lifecycle, skill 구조 설계에 영향을 받았습니다
