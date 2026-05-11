# AGENTS.md

이 파일은 이 저장소를 수정하는 코딩 에이전트를 위한 프로젝트 전용 지침이다. 기능 동작의 기준은
`SPEC.md`이고, 이 파일은 코드를 작성하고 검증하는 방식만 다룬다.

## 문서 기준

- `SPEC.md`는 제품 동작과 경계 조건의 단일 기준이다. 동작, 런타임 경로, 권한 범위, 인증 방식,
  workspace 구조를 바꾸면 같은 커밋에서 `SPEC.md`도 갱신한다.
- `resources/AGENTS.md`는 봇 런타임이 에이전트에게 주입하는 read-only instruction이다. 이 최상위
  `AGENTS.md`와 목적이 다르므로 혼동하지 않는다.
- `references/` 아래 checkout은 구현 참조용이다. 참조 코드를 그대로 복사하기보다 현재 TypeScript
  구조와 dependency 경계에 맞게 옮긴다.

## 개발 명령

- 패키지 매니저는 npm을 사용한다. `package-lock.json`을 기준으로 유지하고 pnpm/yarn lockfile을
  추가하지 않는다.
- Node.js는 `package.json`의 `engines`에 맞춰 24 이상을 전제로 한다.
- Python이 필요한 조사나 참조 실행은 `uv run ...` 또는 `uv sync`를 사용한다. `python`/`python3`를
  직접 호출하는 방식으로 지침을 남기지 않는다.
- 의미 있는 코드 변경 뒤에는 관련 범위에 맞게 검증한다. 릴리스 가능한 상태를 확인할 때는 아래 네
  가지를 모두 실행한다.

```bash
npm run lint
npm run check
npm test
npm run build
```

## TypeScript 지침

- `any`를 쓰지 않는다. 타입을 모르면 `unknown`으로 받고, 경계에서 좁힌다.
- 외부 JSON, YAML frontmatter, LLM 응답, 파일 저장 데이터는 `zod` 같은 런타임 검증으로 파싱한 뒤
  형식화한다. `JSON.parse(...) as T`는 새 코드에서 피한다.
- pi agent tool 파라미터는 TypeBox schema에서 타입이 추론되도록 작성한다. `params as { ... }`를
  반복해서 붙이는 방식은 피한다.
- 라이브러리 제네릭이 넓은 타입을 요구하면 프로젝트 타입 별칭을 만든다. 예: `RuntimeAgentTool`,
  `RuntimeModel`.
- `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`를 전제로 코드를 쓴다.
  optional property에는 불필요한 `undefined`를 넣지 않는다.

## 인증과 런타임 파일

- Codex OAuth 로그인은 `npm run login:codex`가 담당한다. pi-ai CLI의 현재 디렉터리 `auth.json`
  저장 방식에 의존하지 않는다.
- 런타임은 `llm.codex.authPath`의 `codex-auth.json`만 읽는다. 현재 작업 경로의 `auth.json`을
  읽게 만들지 않는다.
- `config.json`과 `codex-auth.json`은 guild workspace 밖에 있어야 하며, agent context, file tool,
  bwrap sandbox에 노출하지 않는다.
- `.env`, `auth.json`, `auth.json.lock`, runtime auth 파일을 커밋하지 않는다.

## Workspace와 보안 경계

- guild workspace 격리는 핵심 불변 조건이다. 파일 도구와 sandbox는 현재 guild workspace 밖을 읽거나
  쓰면 안 된다.
- `resources/AGENTS.md`는 guild workspace로 복사하지 않는다. 런타임에서 읽어 context에 주입할 뿐,
  에이전트가 파일 경로로 접근하게 하지 않는다.
- raw shell fallback을 추가하지 않는다. shell 실행이 필요하면 기존 sandbox 정책과 workspace guard를
  통과하는 도구로 구현한다.
- Discord action 도구는 봇 소유 메시지 수정/삭제 같은 소유권 제한을 코드 레벨에서 유지한다.

## 구현 스타일

- 기존 모듈 경계를 따른다. Discord normalization, conversation orchestration, agent runner,
  workspace/memory/tools 로직을 섞지 않는다.
- 동작 로그는 `src/logger.ts`의 pino logger를 사용한다. 콘솔 기본값은 `pino-pretty`이고,
  `LOG_FORMAT=json`으로 JSON 출력을 강제할 수 있어야 한다. 새 로그에는 Discord 메시지 본문, OAuth
  token, authorization header, refresh token을 넣지 말고 ID, 결정 상태, 소요시간, 길이/개수 같은
  메타데이터를 남긴다.
- pi와 nanobot은 dependency 또는 참조 구현으로만 사용한다. 새 기능은 이 프로젝트의 타입, 테스트,
  sandbox 경계에 맞춰 구현한다.
- 동작 변경은 작게 나누고, 변경한 경계에 테스트를 추가한다. 특히 인증 경로, workspace guard,
  engagement gate, memory lifecycle, Discord action 권한 변경은 회귀 테스트를 둔다.
- `dist/`는 빌드 산출물이다. 소스 변경 커밋에 불필요하게 포함하지 않는다.
- 커밋 메시지는 기존 이력처럼 conventional commit 형식(`fix: ...`, `refactor: ...`, `docs: ...`)을
  사용한다.
