# DAMC Multi-AI Connector

> **1.2.x update**: the tool surface is now 22 tools (writes, decisions, tasks
> and session handoff added), and there is a published remote gateway at
> `POST /mcp` (Streamable HTTP, API-key auth mandatory, rate-limited) next to
> the local `POST /v1/mcp`. Per-client setup lives in `integrations/`
> (`README.md` + `SETUP.md` + `CONFIG.md` + `DAMC_SKILL.md` per AI), the gateway
> reference in `docs/REMOTE_MCP_GATEWAY.md`, the current capability matrix in
> `docs/AI_CONNECTIONS.md`. Connection states (`NOT_CONFIGURED` … `ACTIVE`,
> with `READ_READY`/`WRITE_READY`) and the recent-activity feed
> (`GET /v1/activity/mcp`) are derived from the content-free MCP audit trail.
> Endpoint and tool details below describe the 1.1.0 surface and are kept for
> history.

## 1. What DAMC is

DAMC (Dalur AI Memory Center) is a local, provider-independent memory layer.
The point is simple:

> The AI does not own the memory. DAMC owns the memory.
> Every AI is a client of it.

Change your AI and the knowledge stays. Claude Code, Cursor, Gemini, Grok and
ChatGPT all read and write the *same* memory. There is no Claude memory and no
Cursor memory — there is DAMC memory.

## 2. Architecture

```
  Claude Code     Cursor      Gemini       Grok      ChatGPT
       │            │            │           │           │
       └────────────┴──────┬─────┴───────────┴───────────┘
                           │  MCP (JSON-RPC over HTTP)
                  ┌────────▼─────────┐
                  │ Connector layer  │  src/connectors/mcp
                  │ tools + identity │
                  └────────┬─────────┘
                           │  (no engine logic lives here)
      ┌────────────────────┼────────────────────┐
      │                    │                    │
 Ingestion /         Memory engine        Retrieval
 classification      decision + supersede  search
      └────────────────────┴────────────────────┘
                           │
                     PostgreSQL (local)
```

The connector layer is deliberately thin. It validates arguments, identifies the
caller and shapes results. Every behaviour that matters — classification,
DECISION detection, dimension matching, supersession, duplicate detection —
belongs to the engines underneath and is reached through the same code path a
file import uses.

## 3. Transport

- Endpoint: `POST http://127.0.0.1:8787/v1/mcp`
- Protocol: JSON-RPC 2.0, MCP protocol version `2025-06-18`
- Methods: `initialize`, `tools/list`, `tools/call`, `ping`,
  `notifications/initialized`
- Convenience: `GET /v1/connectors/mcp/tools` returns the same tool list as
  plain HTTP.

Client identity travels in headers and is used for provenance only:

| Header | Meaning |
|---|---|
| `X-DAMC-Client` | `claude-code`, `cursor`, `gemini`, `grok`, `chatgpt`, `manual` |
| `X-DAMC-Client-Version` | optional client version |
| `X-DAMC-Request-Id` | optional correlation id, echoed back |

If no header is present, the `clientInfo` from the MCP `initialize` handshake is
used. Failing that the client is recorded as `unknown`. Names are normalized to
a safe slug; anything unusable becomes `unknown`.

## 4. Tools

| Tool | Purpose |
|---|---|
| `memory_search` | Search shared memory. Omit `query` to list recent. |
| `memory_get` | One memory in full: provenance, versions, both relation directions. |
| `project_memories` | Memories belonging to a project. |
| `memory_create` | Store text through the normal ingestion pipeline. |
| `decision_search` | DECISION memories in any state. |
| `active_decisions` | Only the decisions that currently stand. |
| `task_search` | TASK memories. |
| `damc_context` | Context package. Present since 1.0.0, kept for compatibility. |
| `context_pack` | Structured, size-bounded Context Pack (active decisions/tasks/constraints/important memories/recent activity) for a project — added with the Common Memory layer, see `docs/COMMON_MEMORY_LAYER.md`. Not query-driven, unlike `damc_context`. |
| `server_info` | Version, capabilities, storage, privacy posture. |
| `health` | Confirms the service *and* the database answer. |

Limits: query 500 chars, content 20,000 chars, `limit` max 100 (default 20).

## 5. Memory API semantics

**`memory_create` does not let a client dictate the outcome.** The text runs
through the same classification the import pipeline uses, so:

- `type` is a *hint*. It is recorded in metadata; DAMC decides the real type.
- A decision that was actually declared ("…로 결정했다", "decided to use …")
  becomes `active`. One DAMC only *inferred* — a bare "확정", "Database is
  PostgreSQL" — is kept as `candidate` instead, because nobody stated it. This is
  the promotion gate (`src/services/promotion-gate.ts`).
- A TASK is stored as `candidate` and is never completed by a client.
- Identical content is not stored twice, whichever AI sends it.
- A conflicting decision supersedes the earlier one, with the relation and the
  previous version preserved — but only if the new statement clears the same gate.
  An inferred contradiction cannot retire a declared decision: both are kept, the
  new one as a `candidate` linked by `CONFLICTS_WITH`, and the call reports
  `action: "CONFLICT_PENDING"` so the disagreement is visible rather than
  silently resolved.

If the text carries nothing DAMC extracts as a memory, the response says so
(`stored: false`) rather than pretending something was saved.

## 6. Provenance

Every memory records which client produced it. `provider` on a result is the
client slug, and the full `provenance` block carries the source and conversation
it came from. This is what makes a shared store auditable: you can always ask
which AI asserted something.

## 7. Duplicate handling

Exact duplicates are caught by the existing content hash, across clients. Claude
writing a sentence and Grok writing the identical sentence produces one memory,
with the second call reporting `duplicate: true`.

Semantic near-duplicates (the same fact worded differently in another language)
are **not** merged. That is existing behaviour and was deliberately left alone.

## 8. Decision flow

```
memory_create  ->  classification  ->  DECISION detected
                                   ->  subject + dimension + value extracted
                                   ->  same subject & dimension, different value?
                                        yes -> old row superseded, valid_until set
                                               new row active, supersedes_id set
                                               SUPERSEDES relation stored
                                               previous content kept as a version
```

A deployment *method* and a deployment *date* are different families and never
supersede each other.

## 9. Task flow

Tasks are stored as `candidate` — the promotion gate never promotes a TASK on
write, whatever the extraction confidence. Moving one to `active` is always an
explicit act: `PATCH /v1/memories/:id/status`, or the `task_status` / `task_update`
MCP tools, which require the caller to name the status. Nothing DAMC infers from
prose promotes or completes a task.

## 10. Client status

Status is reported honestly. "Supported" means it was actually driven end to
end; anything else says so. This is the Common Memory Hub matrix — the five
AIs that share one DAMC memory (current detail: `docs/AI_CONNECTIONS.md`):

| Client | Status | Notes |
|---|---|---|
| Claude Code | **SUPPORTED** | Driven end to end against the running server: write, read, decision detection, supersession, duplicate. |
| Cursor | **READY** | The MCP surface it needs was exercised end to end using Cursor's client identity, including reading memory another client wrote. Cursor's own MCP client configuration was **not** tested. |
| Grok | **LIMITED** | Gateway contract exercised under the `grok` identity, including duplicate protection. No official Grok consumer product connects to third-party MCP servers — only MCP-capable xAI/API tooling is a client. |
| Perplexity | **LIMITED** | Same surface exercised; the consumer search product is not an MCP client. MCP-capable Perplexity tooling connects via custom remote connectors. |
| ChatGPT | **LIMITED** | Generic connector interface covers read/context; write/update stay off (platform has no API-key slot). No ChatGPT-side integration was tested. |
| Claude.ai custom connectors | **NOT_SUPPORTED** | Host requires OAuth 2.1; DAMC serves API keys. |

Nothing here is claimed as SUPPORTED on the basis of the protocol alone. For
Cursor, Grok, Perplexity and ChatGPT, DAMC's side is complete and tested; the
client-side configuration is what remains. Live sync and push are
**NOT_SUPPORTED** everywhere: no consumer chat API offers provider-initiated
history sync or message injection, and DAMC does not fake them.

## 11. Connecting a client

Any MCP client that can call JSON-RPC over HTTP:

```
endpoint : http://127.0.0.1:8787/v1/mcp
method   : POST
headers  : Content-Type: application/json
           X-DAMC-Client: cursor
```

Handshake, then call tools:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize",
 "params":{"clientInfo":{"name":"cursor","version":"0.44"}}}

{"jsonrpc":"2.0","id":2,"method":"tools/call",
 "params":{"name":"active_decisions","arguments":{}}}
```

## 12. Security

- `docker-compose.yml` publishes both the API (8787) and PostgreSQL (5432) on
  `127.0.0.1` only, so nothing on the network reaches DAMC in the default
  deployment. `HOST` inside the container is `0.0.0.0` (it has to be, for Docker
  to forward to it) — the loopback restriction is the *published port*, not the
  listener.
- Dev mode (`DAMC_DEV_MODE`, on by default) lets a local request through without
  an API key, and applies **only to requests that originate on this machine**:
  anything arriving with `X-Forwarded-For`, `CF-Connecting-IP` or a sibling
  forwarding header must present a key whatever the flag says. This is enforced
  in `src/http/auth.ts`, so publishing DAMC through Remote Access cannot expose
  `/v1` by leaving dev mode on. See README.md § Authentication for the LAN caveat.
- The remote MCP gateway (`POST /mcp`) always requires an API key, dev mode or
  not, and is rate-limited per key.
- The connector stores **no credentials**. Client identity is a name, a version
  and a request id — never a token, key or password.
- AI provider API keys (`GEMINI_API_KEY`, `GROK_API_KEY`, …) are never read,
  stored, logged or persisted by DAMC. If a client needs one, it belongs in that
  client's own credential mechanism.
- DAMC never uploads memory on its own, and there is no DAMC-operated remote
  server. Two features send data outward only when an operator turns them on:
  GitHub backup (`GITHUB_BACKUP_ENABLED`, pushes an export to a repository you
  configure) and Remote Access (publishes this server through a cloudflared
  tunnel or your own HTTPS endpoint). Both are off by default.
- Internal errors return a generic message; SQL, paths and internals are not
  leaked to clients.

## 13. Error handling

| Situation | Response |
|---|---|
| Malformed JSON-RPC envelope | `-32600` invalid request |
| Unknown method | `-32601` method not found |
| Unknown tool | `-32601`, with the available tool names |
| Bad or missing argument, unknown argument | `-32602` invalid params |
| Missing memory or project | `-32602` with a plain message |
| Internal failure | `-32603`, details logged server-side only |

A bad request never takes the server down; this is covered by tests.

## 14. Test results

Suite at the time this section was written: **212 passing** (182 pre-existing,
unchanged; 30 new connector tests). It has grown since — run `npm test` for the
current figure, and `DAMC_REQUIRE_DB=1 npm test` to include the database-backed
files instead of letting them skip.

Verified against a live server on an isolated database, driving real HTTP:

| Scenario | Result |
|---|---|
| Claude Code writes a decision | stored, DECISION, active |
| Cursor reads what Claude wrote | found, provenance `claude-code` |
| Gemini lists active decisions | returns the standing decision |
| Grok writes identical content | `duplicate: true`, nothing stored |
| Cursor supersedes Claude's DB decision | old superseded, SUPERSEDES relation stored |
| Cursor writes a task, Claude reads it | TASK, still `candidate` |
| Invalid id / tool / envelope | correct error codes, server stays up |

Also verified on the **installed** product: `initialize`, `server_info`,
cross-client write and read, duplicate protection, the REST surface, and data
surviving uninstall and reinstall.

On the development database, Cursor sees all 15 existing memories that were
originally imported from ChatGPT and Claude exports — the shared-memory property
on real data.

## 15. Limitations

- Semantic deduplication is not implemented; only exact duplicates are merged.
- There is no push or subscription: clients poll.
- No per-client access control. Any client that can reach DAMC with a valid
  credential (or from this machine, in dev mode) has the same access as any
  other; an API key scopes to a user, not to a client or a permission set.
- Cursor, Grok, Perplexity and ChatGPT are READY/LIMITED, not SUPPORTED (see
  §10): their own MCP client configuration has not been tested against this
  build, and Grok/Perplexity/ChatGPT consumer surfaces constrain what can
  connect at all.
- `memory_create` stores nothing when the text carries no extractable memory.
  This is intentional — the classification engine is not bypassed — but it means
  a client cannot force an arbitrary note into storage.

## 16. Troubleshooting

**No tools listed** — check `GET /v1/connectors/mcp/tools`. If that fails, the
server is not running: `docker compose ps`.

**`memory_create` returns `stored: false`** — either the content duplicates an
existing memory, or it carried nothing DAMC extracts. The `note` field says
which.

**Client shows as `unknown`** — send `X-DAMC-Client`, or a `clientInfo.name` in
`initialize`.

**Connection refused** — DAMC binds to `127.0.0.1` only, by design. It is not
reachable from another machine.
