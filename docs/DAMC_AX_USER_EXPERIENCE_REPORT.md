# DAMC 1.2.0 — AX / 사용자 경험 진단 보고서

작성 기준: 2026-09-13, 실제 출하본(`release/DAMC_Setup.exe`, 설치본 `C:\Users\…\Programs\DAMC`)과
소스 트리를 처음 보는 사용자의 눈으로 처음부터 끝까지 따라가며 확인한 결과.
아래의 모든 "현재" 항목은 코드 또는 화면에서 직접 확인한 것이고, 추정은 추정이라고 적었다.

---

## 1. Executive Summary

기능은 대부분 있고 검증도 됐다. 문제는 **처음 보는 사람이 그 기능에 도달하는 길**이다.

가장 심각한 것 하나는 기능 자체가 사용자에게 닿지 않는다: **Obsidian 내보내기가 Docker
볼륨 안에 써진다.** Windows의 Obsidian은 그 폴더를 볼 수 없다. 사용자가 "Obsidian 내보내기"
를 누르면 "`/app/storage/obsidian`에 썼습니다"라는, 자기 PC에 존재하지 않는 경로를 받는다.
제품이 내세우는 "DAMC → Obsidian Graph View" 흐름은 지금 출하본에서는 성립하지 않는다.

나머지는 대부분 "무엇을 해야 하는지"를 화면이 말해주지 않는 문제다. 설치 프로그램은
Docker가 꺼져 있으면 "직접 켜고 다시 실행하라"고 하고, 첫 화면은 "메모리가 없습니다"
한 줄로 끝나고, AI 연결의 파란 버튼은 눌러도 화면을 스크롤만 하고, 도움말은 "자세한
건 docs 폴더"로 보낸다.

| 심각도 | 건수 | 대표 |
|---|---|---|
| P0 사용 불가 | 1 | Obsidian 출력이 호스트에서 보이지 않음 |
| P1 큰 혼란 / 기능 접근 방해 | 4 | Docker 꺼짐 처리, AI 연결 버튼, 첫 화면, 설정됨≠연결됨 문구 |
| P2 개선 필요 | 5 | 도움말 떠넘기기, 그래프 메뉴 방향, 기술 용어, import 결과 필드, 설정 화면 문구 |
| P3 polish | 2 | 한국어 사전 중복 키, 설치 프로그램 영어 전용 |

## 2. Target User

- AI를 오래 써서 ChatGPT/Claude 내보내기 파일이 있는 개인 사용자
- 개발자가 아니다. `npm`, `docker compose`, PowerShell을 모른다
- "설치 파일 하나 받아서 실행하면 된다"를 기대한다
- 한국어 사용자. 영어 설치 화면은 읽을 수는 있어도 결정을 미루게 만든다

## 3. First Impression

**현재**: 설치 파일에 서명이 없어 Windows가 "알 수 없는 발행자"를 띄운다. 설치 화면은
영어다. 제품이 뭔지 설명하는 문장은 설치 중 어디에도 없다.

**평가**: 서명은 이번 범위 밖(비용/계정). 영어 설치 화면은 P3 — Inno Setup에 한국어 언어
파일이 이미 있으므로 비용이 거의 없다. 첫 문장은 첫 실행 화면이 담당하면 된다.

## 4. Installation Journey

| 단계 | 현재 동작 | 사용자가 겪는 것 |
|---|---|---|
| Docker 설치됨 + 실행 중 | 통과 | 문제 없음 |
| Docker 설치됨 + **꺼짐** | `docker --version`만 검사하므로 설치는 통과. 설치 끝의 "Start DAMC now"가 `docker version` 실패로 멈추고 "Docker Desktop을 시작한 뒤 다시 실행하세요" | **P1.** 설치 프로그램이 Docker를 켤 수 있는데 사용자에게 시킨다. "다시 실행"이 뭘 다시 실행하라는 건지도 불명확 |
| Docker 없음 | "Docker Desktop was not detected… Install DAMC anyway?" + URL 텍스트 | **P1.** URL을 손으로 옮겨 적어야 한다. 왜 필요한지 한 줄 설명이 없다 |

근거: `release/installer/DAMC.iss` `DockerAvailable()`은 `docker --version`의 종료 코드만 본다.
CLI가 있다고 엔진이 떠 있는 건 아니다. `damc-start.cmd` 20~33행은 엔진이 없으면 안내만
출력하고 종료한다. 이 PC 기준 Docker Desktop은 `C:\Program Files\Docker\Docker\Docker
Desktop.exe`에 있고 레지스트리 Uninstall 항목 "Docker Desktop 4.88.1"로 탐지된다 — 즉
"설치됐지만 꺼짐"은 구분 가능하다.

## 5. First Run Journey

**현재**: 대시보드 첫 화면은 7개의 `0` 타일과 "아직 메모리가 없습니다. 공식 ChatGPT 또는
Claude 내보내기를 가져오면 첫 메모리가 만들어집니다." 한 줄, 그리고 "전역 범위는 프로젝트가
지정되지 않은 메모리만 포함합니다…"라는 문장.

**평가 P1**: "이게 뭐고, 지금 뭘 하면 되는지"가 없다. 환영도, 3단계 안내도, 버튼도 없다.
"전역 범위" 문장은 처음 보는 사람에게 의미가 없다.

## 6. Import Journey

**현재**: 미리보기와 가져오기가 버튼으로 구분돼 있고, 완료 시 "가져오기가 완료되었습니다"
와 provider / 파일명 / 크기 / 조각 수 / 완료 시각이 표시된다. 진행률 바가 있다.

**평가 P2**: 골격은 맞다. 요약 문장이 "대화 N건 중 M건 신규, 메모리 K건"으로 끝나서
messages / decisions / tasks / deduplicated / projects 가 결과 배너에 없다(값은 이미
`outcome`에 있다). Claude 쪽은 "브라우저 다운로드 폴더를 `C:\DAMC_IMPORT`로" 라는 핵심
조건이 화면에는 있으나 첫 화면·도움말에는 없다.

## 7. AI Connection Journey

**현재**: AI 카드마다 [연결] [자동 설정] [설정] [기억 테스트] [기억 보기] 다섯 개 버튼.
파란 [연결]은 눌러도 **페이지를 스크롤해 키 입력칸에 포커스를 줄 뿐**이다
(`connections.js` 558~564행). [자동 설정]과 [설정]은 같은 모달을 연다.

**평가 P1**: 사용자는 "연결"을 누르면 연결되는 줄 안다. 아무 일도 안 일어난다고 느낀다.
키가 왜 필요한지, 만든 키를 어디에 넣는지, 그다음 뭘 확인하는지가 한 흐름으로 이어지지
않는다. 상태 칩의 CONFIGURED 설명문이 "연결은 되었지만 미사용"이라서 **설정됨을 연결됨으로
읽게 만든다** — 이 제품이 가장 피하려는 오해다.

**MCP vs API**: 카드 여섯 개가 한 줄로 나열되고 Hermes(MCP 에이전트)와 ChatGPT(앱 커넥터)
가 같은 모양이다. "MCP"는 설명 없이 등장한다.

## 8. Hermes Journey

**현재**: 카드 한 장 + 모달의 설정 단계. 이번 릴리스에서 실제로 동작하는 유일한 에이전트
경로이고 서버 로그로 검증됐다.

**평가 P2**: 동작은 하지만 "MCP 연결"이라는 종류 표시가 없고, 설치 위치가 다른 카드들과
섞여 있다. Hermes 쪽의 함정 두 개(tool_search off, 클라이언트 헤더)는 팩 문서에는 있으나
화면 설정 단계에도 있어야 한다 — 이미 카탈로그 steps에 넣었으므로 화면 노출은 된다.

## 9. Obsidian Journey

**현재**: 설정 화면 맨 아래 "Obsidian 내보내기 — POST /v1/export/obsidian — OBSIDIAN_VAULT_PATH
또는 DATA_DIR/obsidian 에 Markdown과 위키링크를 씁니다" 버튼 하나. 실행하면
"`/app/storage/obsidian` · 노트 N건" 토스트.

**평가 P0**: 출하 compose는 `/app/storage`를 이름 있는 Docker 볼륨(`damc_storage`)으로
붙인다. 사용자 PC에 `/app/storage/obsidian`은 없다. Obsidian이 열 수 있는 폴더가
어디에도 만들어지지 않는다. 문구도 API 경로와 환경변수 이름이라 사용자 언어가 아니다.
별도 "그래프" 메뉴는 DAMC 내부 SVG 그래프를 그리는데, 제품 방향은 그래프를 Obsidian에
맡기는 것이다 — 메뉴가 방향과 반대다.

## 10. Empty State

**현재**: 각 화면이 "없습니다" 계열 문구를 표시한다. DB에 데모 행은 없다(테스트로 고정).

**평가 P1(첫 화면) / 통과(나머지)**: 데이터 정직성은 통과. 첫 화면만 "다음에 뭘 하나"가
빠져 있다.

## 11. Error Recovery

| 상황 | 현재 | 평가 |
|---|---|---|
| Docker 꺼짐 상태에서 시작 | 안내 후 종료 | P1 — 자동 기동 가능 |
| 가져오기 실패 | 오류 코드 + 원인 + 다음 행동 표시 | 통과 |
| 키 분실 | 대시보드 재접속 시 자동 재발급 | 통과 |
| Obsidian 폴더 못 찾음 | 안내 없음 | P0와 동일 원인 |

## 12. Mental Model

사용자가 가져야 할 모델은 네 문장이다.

1. DAMC는 AI의 장기 기억을 저장하는 개인 Memory Center다.
2. ChatGPT와 Claude에서 데이터를 가져와 DAMC를 채운다.
3. Hermes 같은 AI를 연결하면 DAMC의 기억을 활용한다.
4. Obsidian과 연결하면 사람이 지식 관계를 Graph View에서 본다.

현재 화면 어디에도 이 네 문장이 한 곳에 없다. 도움말은 1·2·3을 흩어서 말하고 4는 없다.

## 13. Current Friction (전체 목록)

| # | 여정 | 문제 | 근거 |
|---|---|---|---|
| F1 | Obsidian | 출력이 Docker 볼륨 안 | `export-service.ts:9`, compose `damc_storage:/app/storage` |
| F2 | 설치 | Docker 꺼짐을 자동 기동하지 않음 | `DAMC.iss DockerAvailable`, `damc-start.cmd:20` |
| F3 | 설치 | Docker 없음 안내가 URL 텍스트뿐 | `DAMC.iss:107-112` |
| F4 | AI 연결 | [연결] 버튼이 스크롤만 함 | `connections.js:560-564` |
| F5 | AI 연결 | CONFIGURED 문구가 "연결은 되었지만" | `i18n.js connections.unusedHint` |
| F6 | AI 연결 | MCP 에이전트와 앱 커넥터 미구분, MCP 설명 없음 | `connections.js:262` 단일 목록 |
| F7 | 첫 실행 | 환영/3단계/버튼 없음 | `overview.js` |
| F8 | 도움말 | "전체 설명서는 docs 폴더" | `help.js` intro, docs 섹션 |
| F9 | 도움말 | Obsidian·데이터 위치·재설치 시 데이터·완료 확인법 항목 없음 | `help.js SECTIONS` |
| F10 | 그래프 | 메뉴 "그래프"가 내부 SVG 그래프 | `graph.js`, `nav.graph` |
| F11 | Import | 결과 배너에 messages/decisions/tasks/dedup/projects 없음 | `import.js:456-462` |
| F12 | 설정 | Obsidian 문구가 API/환경변수 | `settings.obsidianExportBody` |
| F13 | 사전 | KO 사전에 `connections.autoSetup` 등 8개 키 중복 | `i18n.js:1127-1142` |
| F14 | 설치 | 설치 화면 영어 전용 | `[Languages] english` 만 |

## 14. Severity

- **P0**: F1
- **P1**: F2, F4, F5, F7 (+F3, F6은 P1 경계)
- **P2**: F8, F9, F10, F11, F12
- **P3**: F13, F14

## 15. Proposed UX Fix

| # | 수정 | 원칙 |
|---|---|---|
| F1 | 출하 compose에 `C:\DAMC_OBSIDIAN` 바인드 마운트 + `OBSIDIAN_VAULT_PATH=/damc-obsidian`. 시작 스크립트가 폴더 생성. 상태 API(`GET /v1/export/obsidian/status`)로 폴더 존재·노트 수·마지막 동기화 표시. DAMC = source of truth, Obsidian = 보기 | 파일 위치를 사용자 PC로 |
| F2 | 설치 프로그램: 레지스트리/실행파일로 Docker Desktop 설치 여부 판정 → 설치됐고 꺼져 있으면 실행 후 `docker info` 준비까지 대기(진행 표시) → 준비되면 계속. `damc-start.cmd`도 동일 로직 | 사용자에게 시키지 않는다 |
| F3 | Docker 없음: "DAMC를 실행하려면 Docker Desktop이 필요합니다" + [다운로드 페이지 열기](공식 URL) + 계속 설치 여부. 비공식 바이너리 배포 없음 | 공식 경로만 |
| F4 | [연결] 제거. [연결 설정]이 모달을 열고 1단계 키 만들기 → 2단계 설정 복사 → 3단계 연결 테스트로 안내. 테스트 결과 ✓/✕ + 원인 + 다음 단계 | 버튼 이름이 동작을 설명 |
| F5 | 상태 라벨/설명 재작성: 설정됨(키만 있음) / 인증됨 / 읽기·쓰기 확인 / 활성. "연결됨"은 활동 기반 상태에만 | 설정됨 ≠ 연결됨 |
| F6 | 카드 두 그룹: "AI 에이전트 — MCP 연결"(Hermes, Cursor, Claude Code) / "AI 서비스"(ChatGPT, Grok, Perplexity). 헤더에 MCP 한 줄 설명 | 기술명은 괄호로 |
| F7 | 모든 집계가 0이면 환영 카드: 네 문장 + 3단계 + [ChatGPT 가져오기] [Claude 가져오기] [AI 연결] [Obsidian 연결] | 다음 행동이 보인다 |
| F8/F9 | 도움말을 자급자족으로: 12개 필수 주제 전부 인앱. docs는 "개발/배포 문서"로만 언급 | docs로 떠넘기지 않는다 |
| F10 | 메뉴 "그래프" → "Obsidian". 내부 SVG 그래프 페이지 제거. 그래프 엔진 추가 없음 | 방향 정합 |
| F11 | 결과 배너에 conversations / messages / imported / deduplicated / memories / decisions / tasks / projects / completed_at 전부(값이 있을 때만) | 실측값만 |
| F12 | 설정 화면 문구를 사용자 언어로, Obsidian 페이지로 안내 | |
| F13 | 중복 키 제거 | |
| F14 | 설치 프로그램 한국어 언어 파일 추가, 안내 문구 한/영 | |

## 16. Final User Journey

```
DAMC_Setup.exe 실행
  → "시스템을 확인하는 중…"
  → Docker Desktop 있음/켜짐   → 계속
     Docker Desktop 있음/꺼짐  → 자동 실행, 준비될 때까지 대기 (진행 표시)
     Docker Desktop 없음       → 왜 필요한지 + [다운로드 페이지 열기] + 계속 여부
  → DAMC 설치 → PostgreSQL → 마이그레이션 → 상태 확인 → 브라우저 자동 실행
첫 화면
  → "DAMC에 오신 것을 환영합니다 / 아직 저장된 데이터가 없습니다"
  → 3단계 안내 + [ChatGPT 가져오기] [Claude 가져오기] [AI 연결] [Obsidian 연결]
가져오기
  → 미리보기(저장 없음) → 가져오기 → 진행률 → ✓ 가져오기가 완료되었습니다 + 실측 결과 전부
AI 연결
  → 그룹별 카드 → [연결 설정] → 키 만들기 → 설정 복사 → 연결 테스트 → 상태 칩이 활동 기반으로 변함
Obsidian
  → [Obsidian 동기화] → C:\DAMC_OBSIDIAN 에 노트 생성 → Obsidian에서 그 폴더를 Vault로 열기 → Graph View
일상
  → AI에게 "이거 기억해" / 새 대화에서 과거 맥락 회수 / 몇 달마다 export 재가져오기
```

## 17. Acceptance Criteria

- [ ] 클린 설치 후 첫 화면에 환영 문구·3단계·4개 버튼이 보이고 DB 행은 0이다
- [ ] Docker 꺼진 상태에서 설치/시작하면 사용자 개입 없이 Docker가 켜지고 DAMC가 뜬다
- [ ] Docker 없는 환경에서 설치하면 이유 + 공식 다운로드 링크 + 계속 여부를 묻는다
- [ ] [연결 설정] 흐름만으로 키 생성 → 설정 → 테스트가 끝나고, 상태 칩은 활동이 있어야 활성이 된다
- [ ] CONFIGURED 상태 어디에도 "연결됨"이라는 단어가 없다
- [ ] Obsidian 동기화 후 Windows 탐색기에서 노트 파일이 보이고, Obsidian이 그 폴더를 Vault로 연다
- [ ] 메뉴에 "그래프"가 없고 "Obsidian"이 있다. 내부 그래프 렌더러가 없다
- [ ] 도움말이 12개 필수 주제를 모두 담고 docs 폴더를 열라고 요구하지 않는다
- [ ] 가져오기 완료 배너에 실측 필드가 모두 나온다
- [ ] 375px / 1440px에서 첫 화면·가져오기·AI 연결·Obsidian이 가로 스크롤 없이 동작한다
- [ ] 기존 테스트 763건 유지, 신규 테스트 통과, 설치 파일 재생성 + SHA256 일치

---

## 18. Validation Results

수정 후, 이 저장소의 출하본으로 실측한 결과. 2026-09-13 ~ 14.

| 항목 | 결과 | 근거 |
|---|---|---|
| F1 Obsidian 출력 위치 | **고침** | `C:\DAMC_OBSIDIAN` 바인드 마운트. 실 데이터 4,065건 동기화 16초, 실패 0, 관계 위키링크 22개 전부 실제 파일로 해석됨, 인덱스 링크 끊김 0 |
| F1-b (동기화 중 발견) | **고침** | 노트 파일명이 150 *문자*로 잘려 `ENAMETOOLONG`(255 *바이트* 한계) → 120바이트 한계·NTFS 금지 문자·예약어 처리. 관계 링크가 `[[제목]]`으로 파일명(`제목-id8`)과 달라 그래프 선이 안 그려지던 문제도 함께 고침 |
| F2/F3 Docker 없음 | **고침** | 스크립트 수준: Docker Desktop.exe 부재 환경에서 즉시 "설치 필요 + 공식 URL" 안내, 종료 코드 3 |
| F2 Docker 꺼짐 | 아래 §18-1 | |
| F4 [연결] 버튼 | **고침** | 카드에 [연결 설정] [연결 테스트] [메모리 보기]. 대화상자 3단계(키 생성 → 설정 → 테스트) |
| F5 설정됨≠연결됨 | **고침** | 칩 "설정됨 (미연결)", 힌트 "설정됨은 연결됨이 아닙니다"; "연결됨"은 활성 상태에만. 테스트로 고정 |
| F6 MCP/앱 구분 | **고침** | "AI 에이전트 — MCP 연결"(Hermes·Cursor·Claude) / "AI 서비스 — 앱 연결"(ChatGPT·Grok·Perplexity) + MCP 한 줄 설명 |
| F7 첫 화면 | **고침** | 집계가 전부 0일 때만 환영 카드(4문장·3단계·4버튼). clean 설치에서 DB 0행 확인 |
| F8/F9 도움말 | **고침** | 12개 필수 주제 인앱, docs 폴더 언급은 "개발자용, 사용에 불필요" 한 줄뿐. 테스트로 고정 |
| F10 그래프 메뉴 | **고침** | 메뉴 "Obsidian", 내부 SVG 그래프 페이지 삭제, 그래프 엔진 의존성 없음(테스트) |
| F11 Import 결과 | **고침** | 대화/메시지/신규/중복/기억/결정/작업/프로젝트/완료시각 — 값이 있을 때만 |
| F12 설정 문구 | **고침** | 사용자 언어로 |
| F13 사전 중복 | **고침** | KO 중복 8키 제거 |
| F14 설치 언어 | **고침** | Korean.isl + 한/영 CustomMessages |
| 375px | **PASS** | overview/help/import/connections/obsidian 가로 스크롤 0, 사이드바 드로어·메뉴 버튼 동작 |
| 1440px | **PASS** | 전 페이지 렌더 확인 |
| 테스트 | **793 PASS / 0 FAIL / 0 SKIP** (41 files) | baseline 763 → 793 (+30 신규). 삭제·skip 없음. 변경한 기존 단언은 제품 규칙이 바뀐 곳(image load 규칙)뿐이며 더 강한 규칙으로 교체 |

### 18-1. 콘솔 창 제거 / 조건부 image load (추가 요청)

| 시나리오 | 결과 |
|---|---|
| A. 클린 설치, image 없음 | 설치 37초, image load **1회**, health 200, 보이는 콘솔 창 **0** (46회 샘플) |
| B/C. 두 번째 실행, Docker 실행 중 | 19초, image load **0**, 콘솔 창 0 |
| E. 이미 실행 중 | "already running - nothing to do", load 0, 컨테이너 StartedAt 불변 |
| F. 컨테이너 정지 상태 | start만, 같은 컨테이너 id, load 0 |
| G. image 삭제 후 | 1차 load 1회 → 2차 load 0회 |
| H. 오류(포트 8787 점유) | nogui 종료코드 7, 로그 "FAILED: compose up"; GUI 모드에서 제목 "DAMC" 대화상자 1개 표시, 콘솔 창 0 |
| D. Docker Desktop 꺼짐 | **PARTIAL** — 두 번 시도(강제 종료 1회, `docker desktop stop` 정상 종료 1회) 모두 런처를 대화형 세션의 예약 작업으로 실행하자 Docker Desktop이 몇 초 안에 떠서 DAMC가 14~20초에 응답했고 콘솔 창은 0이었다. 그러나 두 번 다 시작 로그에 "launching Docker Desktop" 분기가 기록되지 않아, 엔진을 되살린 주체가 런처인지 Docker Desktop 자체 복구인지 이 환경에서는 분리해 증명하지 못했다. 분기 자체는 정적 테스트로 고정되어 있고, Docker가 아예 없는 환경(Case C)은 즉시 안내·종료가 실측됐다. 실제 사용자 PC에서 트레이 종료 후 시작 메뉴 클릭으로 확인하는 것이 남아 있다 |

수치는 전부 `%LOCALAPPDATA%\DAMC\logs\damc-start.log`와 프로세스 창 샘플링(cmd/powershell/conhost/wscript의 MainWindowHandle)에서 읽었다.
