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

## 특정 서버/채널로 제한

기본적으로 봇이 들어간 모든 서버와 채널에서 동작합니다. 특정 서버나 채널만 허용하려면 `config.json`을 수정합니다:

```json
{
  "discord": {
    "allowedGuildIds": ["서버ID1", "서버ID2"],
    "allowedChannelIds": ["채널ID1"]
  }
}
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
