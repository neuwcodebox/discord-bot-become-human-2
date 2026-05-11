# Discord Bot Become Human 2 — 고수준 구현 계획

## 진행 현황

- [x] Phase 1 기반 프로젝트 초기화: Node.js 24 / TypeScript / ESM / npm / tsdown / tsx / biome / vitest 구성
- [x] 런타임 루트와 config skeleton 생성 로직 구현
- [x] guild workspace template 복사와 누락 파일 보수 생성 구현
- [x] `resources/AGENTS.md`를 workspace에 복사하지 않는 read-only instruction 구조 구현
- [x] workspace guard 구현 및 symlink/path traversal 테스트 추가
- [x] guild별 USER.md/aliases.json lazy 생성 구현
- [x] Discord event 정규화, append-only `events.jsonl`, XML-like transcript builder 구현
- [x] ContextBuilder 4종(engagement/stay/response/Dream) 골격 구현
- [x] pi Codex agent runner wrapper와 workspace/memory/summarize/weather/fetch/sandbox 도구 골격 구현
- [x] conversation state, strong trigger, hard gate, cooldown, streaming writer 골격 구현
- [x] `npm run check`, `npm run lint`, `npm test`, `npm run build` 통과
- [x] Discord action tools를 agent tool registry에 연결
- [x] attachment reader를 agent tool registry에 연결
- [x] `.cursor` compaction cursor와 event cursor 분리
- [x] Dream runner에 `resources/AGENTS.md`와 workspace tools 주입
- [x] Dream scheduler interval/compaction trigger 골격 구현
- [x] attachment image content block 반환 구현
- [x] `weather_lookup` Open-Meteo 기반 구현
- [x] Dream memory 변경 파일 audit와 inbox processed 처리 구현
- [x] Dream workspace_write 편집 범위 도구 레벨 제한 구현
- [ ] Discord 실제 샌드박스/실서버 통합 검증
- [ ] SPEC 전체 완료 감사

## 0. 기준 문서 확정

### SPEC.md를 단일 사양 기준으로 고정

### 구현 중 의사결정 원칙 정리

### 참조 프로젝트 확보

### Agent Skills 참조 문서 확보

---

## 1. 프로젝트 초기화

### Node.js / TypeScript / ESM 환경 구성

### 패키지 의존성 구성

### 기본 디렉터리 구조 생성

### 개발·실행 스크립트 구성

---

## 2. 런타임 루트 구성

### `~/.discord-bot-become-human-2` 경로 처리

### `config.json` 로딩

### `codex-auth.json` 경로 처리

### 소스 내 `AGENTS.md` 주입 구조 구성

---

## 3. Guild Workspace 구성

### guild별 workspace 경로 생성

### workspace template 복사

### workspace guard 구현

### guild 간 격리 검증

---

## 4. Discord Adapter 구현

### Discord client 초기화

### guild / channel / thread 식별

### 메시지 이벤트 수집

### 메시지 수정·삭제·reaction 이벤트 수집

### Discord 전송 계층 구현

---

## 5. Discord 메시지 정규화

### 사용자 식별 정보 정규화

### reply / reference 정규화

### attachment / embed / link 정규화

### reaction / edit / delete 정규화

### normalized event 저장

---

## 6. 사용자 프로필 관리

### 사용자별 `USER.md` lazy 생성

### `aliases.json` 갱신

### 관련 사용자 프로필 선택

### 사용자 프로필 context 로딩

---

## 7. 서버 메모리 기반 구성

### `events.jsonl` 기록

### `history.jsonl` 압축 흐름

### `inbox.jsonl` 기억 후보 기록

### `MEMORY.md` 로딩

### Dream 실행 기록 관리

---

## 8. Agent Runtime 구성

### OpenAI Codex provider 연결

### 기본 모델 `gpt-5.5` 설정

### pi agent harness 연결

### tool registry 연결

### agent event stream 처리

---

## 9. Context Builder 구현

### 공통 context role 구조 구현

### XML-like transcript builder 구현

### engagement decision context 구성

### stay decision context 구성

### response generation context 구성

### Dream context 구성

---

## 10. Skill 시스템 구현

### builtin skill template 구성

### guild workspace로 skill 복사

### skill metadata 로딩

### task별 skill 선택

### `skill-creator` 동작 범위 제한

---

## 11. Conversation Orchestrator 구현

### `not_engaged` / `engaged` 상태 관리

### 강한 trigger rule 구현

### 참여 여부 decision 구현

### 참여 유지 decision 구현

### reply cadence 제어

### debounce / cooldown 런타임 처리

---

## 12. ReAct 응답 생성 구현

### 응답 대상 메시지 결정

### response agent run 시작

### tool call / tool result loop 처리

### 최종 Discord 메시지 생성

### 상태 전이 반영

---

## 13. Discord 실시간 편집 전송 구현

### placeholder 메시지 생성

### delta buffer 관리

### 주기적 message edit 처리

### 메시지 길이 제한 처리

### 코드 블록 경계 처리

### 다중 메시지 스트리밍 처리

---

## 14. Tool 구현

### workspace file tools

### memory tools

### summarize tool

### weather tool

### Discord action tools

### attachment reader

### URL fetcher

### sandbox exec tool

---

## 15. bwrap Sandbox 구현

### bwrap 실행 래퍼 구현

### workspace bind 정책 구현

### timeout / output limit 처리

### network 정책 처리

### symlink / path traversal 방어

---

## 16. Dream Memory 구현

### Dream trigger 구성

### Dream agent runner 구성

### history / inbox cursor 처리

### 장기 기억 파일 편집 흐름

### dream run audit 기록

---

## 17. 운영 설정과 기본값 조정

### 기본 config template 정리

### 유용한 기본 동작 검증

### guild / channel allowlist 동작 검증

### 기능별 enable flag 정리

---

## 18. 통합 테스트

### workspace 초기화 테스트

### Discord 이벤트 정규화 테스트

### context 생성 테스트

### conversation state 테스트

### streaming writer 테스트

### tool sandbox 테스트

### memory lifecycle 테스트

---

## 19. 실제 Discord 서버 검증

### bot mention 응답 검증

### reply 기반 응답 검증

### 자연 참여 판단 검증

### engaged 상태 발화 빈도 검증

### attachment 처리 검증

### Dream memory 갱신 검증

---

## 20. 문서화와 마감

### README 작성

### 설정 가이드 작성

### Codex 인증 가이드 작성

### workspace 구조 설명 작성

### 운영·백업 가이드 작성

### SPEC.md와 구현 결과 대조
