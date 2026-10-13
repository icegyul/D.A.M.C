# DAMC MCP 상호운용성

DAMC는 특정 AI 전용 커넥터가 아니라 **범용 MCP 서버**다. MCP를 말할 수 있는
클라이언트라면 같은 기억을 읽고 쓴다.

이 문서는 설계 의도가 아니라 **이 저장소에서 실제로 확인된 것**을 적는다. 확인되지
않은 것은 확인되지 않았다고 쓴다.

---

## 1. 구조

```
                          ┌─────────────────────────┐
                          │          DAMC           │
                          │  PostgreSQL 17 (로컬)    │
                          │                         │
                          │  Memory / Decision      │
                          │  Task / Conversation    │
                          └────────────┬────────────┘
                                       │
                          ┌────────────┴────────────┐
                          │      MCP SERVER         │
                          │  POST /v1/mcp  (로컬)    │
                          │  POST /mcp     (게이트웨이)│
                          │      22 tools           │
                          └────────────┬────────────┘
                                       │
                  ┌────────────────────┼────────────────────┐
                  ▼                    ▼                    ▼
             MCP CLIENT           MCP CLIENT           MCP CLIENT
```

DAMC는 클라이언트를 호출하지 않는다. 클라이언트가 DAMC에 접속한다. 그래서 AI를
추가·교체해도 기억은 이동하지 않는다.

## 2. 엔드포인트 두 개

| 경로 | 용도 | 인증 |
|---|---|---|
| `POST /v1/mcp` | 같은 기계의 클라이언트 | API key 필수 (production) |
| `POST /mcp` | 터널·리버스 프록시 뒤의 원격 클라이언트 | API key 필수, dev mode에서도 예외 없음 |

둘 다 같은 22개 tool을 노출한다. 로컬은 `/v1/mcp`, 원격은 `/mcp`를 쓴다. 이 구분을
틀리는 것이 연결 실패의 가장 흔한 원인이다.

## 3. 인증

```
Authorization: Bearer <DAMC API key>
```

| 요청 | 결과 |
|---|---|
| 헤더 없음 | 401 |
| 잘못된 key | 401 |
| 유효한 key | 200 + tools |

key는 해시로 저장된다. 생성 직후 한 번만 보이고 다시 볼 수 없으며, 취소는 즉시
적용된다. **어떤 클라이언트 설정 파일에도 key를 평문으로 적지 않는다** — 환경변수나
비밀 저장소 참조를 쓴다.

## 4. 클라이언트 신원과 provenance

DAMC는 기억을 누가 건드렸는지 기록한다. 신원은 두 곳에서 읽는다.

1. 전송 헤더 `x-damc-client` (그리고 `x-damc-client-version`)
2. 없으면 MCP `initialize` 핸드셰이크의 `clientInfo.name`

**중요한 함정**: `clientInfo`는 `initialize`에만 실려 온다. 이후의 모든
`tools/call`에는 없다. 그래서 헤더를 보내지 않는 클라이언트는 핸드셰이크만
자기 이름으로 남고 **실제 호출은 전부 `unknown`으로 기록된다.** AI 연결 센터가
"어느 AI가 내 기억을 만졌는가"에 답하려면 헤더가 필요하다.

실측 예 (같은 tool, 헤더 추가 전후):

```
13:16:06  client=unknown   health     ← 헤더 없음
13:16:44  client=hermes    health     ← X-DAMC-Client: hermes 추가 후
```

DAMC 쪽은 고칠 것이 없었다. 클라이언트 설정에 헤더 한 줄을 더한 것이 전부다.

## 5. 연결 상태 모델

설정이 있다는 것과 연결되었다는 것은 다르다. DAMC는 **서버측 증거**로만 상태를
판정한다.

| 상태 | 뜻 |
|---|---|
| `NOT_SUPPORTED` | 그 플랫폼에 연결 경로 자체가 없다 |
| `NOT_CONFIGURED` | API key도 없고 활동도 없다 |
| `CONFIGURED` | key는 있으나 이 클라이언트가 한 번도 나타나지 않았다 |
| `AUTHENTICATED` | 핸드셰이크는 했으나 tool 호출이 없다 |
| `READ_READY` | 과거에 읽은 적이 있다 |
| `WRITE_READY` | 과거에 쓴 적이 있다 |
| `ACTIVE` | 최근(1일 이내) tool 호출이 있다 |

`CONFIGURED`에서 `ACTIVE`로 가는 것은 사용자가 무언가를 켰기 때문이 아니라
**감사 로그에 그 클라이언트의 호출이 찍혔기 때문**이다.

### DAMC가 판정할 수 없는 것

DAMC는 컨테이너 안에서 돌기 때문에 호스트의 파일을 볼 수 없다. 따라서:

- 어떤 AI가 이 PC에 **설치되어 있는지** 알 수 없다
- 그 AI의 **설정 파일에 DAMC가 적혀 있는지** 알 수 없다

그래서 AI 연결 센터는 "설치됨/미설치"를 주장하지 않는다. 말할 수 있는 것은
"이 클라이언트가 DAMC를 호출한 적이 있는가"뿐이고, 그것이 실제로 검증 가능한
유일한 사실이다. 설치 여부는 사용자가 자기 기계에서 확인할 문제다.

## 6. 검증된 클라이언트

### Hermes Agent v0.21.2 — 검증 완료

전 과정이 DAMC 감사 로그로 확인되었다: 핸드셰이크, `tools/list` 22개, 실제 읽기,
실제 쓰기, 그리고 **다른 세션에서의 재조회**.

설정과 함정은 [integrations/hermes/](../integrations/hermes/README.md)에 있다.
요약하면 두 가지가 결정적이다.

- `tools.tool_search.enabled: "off"` — 기본값 `"auto"`에서 Hermes는 MCP tool을
  `tool_search`/`tool_describe`/`tool_call` 브리지 뒤로 접는다. 22개가 접힌 상태에서
  모델에게 보이는 tool은 25개였고 그중 DAMC는 없었다. 자연어 질문에 모델은
  "`tool_call`로 호출해야 합니다"라고만 답하고 멈췄으며 **DAMC 호출은 0건**이었다.
  브리지를 끄자 같은 질문에서 `decision_search`와 `memory_search`가 즉시 발생했다.
- `X-DAMC-Client: hermes` — §4 참조.

또 하나: 장기 실행 중인 `hermes gateway`(텔레그램 등)는 **시작 시점의 설정을 계속
쓴다.** 설정을 바꾼 뒤 `hermes gateway restart`를 하지 않으면 CLI에서는 되고
텔레그램에서는 안 되는 상태가 된다.

### 그 밖의 MCP 클라이언트

`integrations/` 아래에 Claude, Cursor, ChatGPT, Grok, Perplexity 팩이 있다. 각
팩은 그 제품의 실제 제약을 적어 둔다 — 예컨대 OAuth만 지원해서 API key를 직접
보낼 수 없는 경우처럼. **연결을 꾸며내지 않는다.**

### 확인되지 않은 것

| 대상 | 상태 | 이유 |
|---|---|---|
| OpenClaw | **NOT INSTALLED** | PATH·AppData·npm 전역 어디에도 없다. 공식 설정 schema를 읽을 수 없어 카탈로그에 추가하지 않았다 |
| Orca | **NOT INSTALLED** | 같은 이유. 게다가 "Orca"는 동명 제품이 여럿이라 어느 것인지 특정할 수 없다 |

설치되지 않은 에이전트를 위해 추측으로 설정 항목을 만들지 않는다. 실제로 설치되면
Hermes와 같은 순서로 추가한다 — **먼저 그 제품의 설정 로더를 읽고**, 그 다음에 항목을
쓴다.

## 7. 공유 기억 검증 방법

여러 AI가 같은 기억을 본다는 주장은 다음을 모두 만족해야 한다.

1. Agent A가 쓴다 → DAMC 감사 로그에 그 클라이언트의 write가 찍힌다
2. DAMC DB와 REST API에서 같은 값이 보인다
3. Agent B가 읽는다 → 감사 로그에 B의 read가 찍힌다
4. B가 돌려준 값이 1의 값과 **문자 단위로** 같다

4번만으로는 부족하다. B가 자기 세션 기억이나 로컬 파일에서 답했을 수 있다. 그래서
B의 실행에서 **DAMC 외의 경로를 실제로 제거**해야 한다. Hermes의 경우 `-t damc`가
toolset 목록을 대체하므로 그 프로세스에는 terminal·file·memory·session-search tool이
아예 없다.

음성 대조군도 함께 둔다. DAMC에 접근할 수 없는 프로필로 같은 질문을 하고,
DAMC 감사 로그에 **호출이 0건**임을 확인한 뒤 그 답이 "모른다"인지 본다. 이것이
인과를 보여준다.

## 8. 사용자 지정 MCP 연결

MCP를 말하는 클라이언트라면 무엇이든 연결할 수 있다. 필요한 것은 endpoint,
transport, 인증 헤더뿐이다.

연결 전에 확인할 것:

- URL이 `http`/`https`인지, 사설망·로컬호스트 정책에 맞는지
- key를 파일에 평문으로 적지 않았는지
- transport가 그 클라이언트가 실제로 지원하는 것인지 (HTTP인지 stdio인지)

## 9. API 의미상 주의점

**`count`는 총계가 아니다.** `active_decisions` 같은 tool의 응답에 있는 `count`는
**이번 페이지의 길이**이고 DB 전체 개수가 아니다. 현재 이 tool들은 pagination
cursor를 제공하지 않는다. 실측: 활성 결정이 881건인 상태에서 응답은
`{count: 20, decisions: [20건]}`이었고, 이 값을 총계로 오해한 에이전트가 "20건"이라고
보고했다. **에이전트 지시문에 이 사실을 명시해야 한다.**

**`candidate`는 확정 사실이 아니다.** 대화에서 추출된 항목은 promotion gate를 통과하지
못하면 `candidate`로 남는다. 읽는 쪽이 `status`를 보고 판단해야 한다.

**`project_id`를 추측하지 않는다.** 가져온 기억 대부분은 project_id가 없다. 프로젝트로
좁히려면 프로젝트 이름을 **질의 텍스트에** 넣는다.

## 10. 문제 해결

| 증상 | 원인 |
|---|---|
| 401 | key 없음/오류/취소됨 |
| 404 | 경로 혼동. 로컬 `/v1/mcp`, 원격 `/mcp` |
| 연결은 되는데 AI가 DAMC를 안 씀 | 클라이언트의 tool 지연/검색 브리지. Hermes는 `tool_search.enabled: "off"` |
| 활동이 `unknown`으로 기록됨 | `x-damc-client` 헤더 없음 |
| CLI는 되고 채팅 봇은 안 됨 | 게이트웨이가 옛 설정으로 실행 중 |
| tool이 전부 사라짐 | 클라이언트의 안전 모드가 MCP를 끈 경우 |
| 연결 테스트는 통과, 실제 사용은 실패 | 전송 검증과 모델 사용은 다른 문제다. 감사 로그를 본다 |
