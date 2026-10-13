# DAMC AI Connections

Every AI client — local or cloud — talks to the **same** DAMC memory through
the **same** MCP surface. This document is the current (1.2.x) map of that
surface and each provider's real capabilities. "Supported" below means the
platform path exists today; "Ready" means it also works end-to-end with a
DAMC API key right now.

## Endpoints

| Endpoint | Transport | Auth | Purpose |
|---|---|---|---|
| `POST /mcp` | MCP Streamable HTTP | **always required** — `Authorization: Bearer damc_…` | the published gateway for every AI client (local + remote) |
| `POST /v1/mcp` | JSON-RPC | Bearer key, or dev mode on loopback | local convenience surface (kept for 1.0/1.1 clients) |
| `GET /v1/connectors/mcp/tools` | REST | same as `/v1` | plain-JSON tool list |

Transport details, rate limiting and the security model: `docs/REMOTE_MCP_GATEWAY.md`.
Per-client setup with copy-ready configs: `integrations/<provider>/SETUP.md`.

## Tool surface (22 tools)

| Group | Tools |
|---|---|
| Read | `memory_search`, `memory_get`, `project_memories`, `decision_search`, `active_decisions`, `task_search` |
| Context | `context_pack`, `damc_context` (1.0.0 compat) |
| Write | `memory_create`, `memory_update`, `memory_restate` |
| Decisions | `decision_create`, `decision_update`, `decision_supersede` |
| Tasks | `task_create`, `task_update`, `task_status` (explicit only) |
| Session | `session_start`, `session_context`, `session_save` |
| Meta | `server_info`, `health` |

## Provider capability matrix (current reality)

| Provider | Read | Write | Update | Context | Session | Live sync | Push | Setup path |
|---|---|---|---|---|---|---|---|---|
| Claude | ✓ | ✓ | ✓ | ✓ | ✓ | ✕ | ✕ | Claude Code one-liner; Desktop via mcp-remote; Claude.ai web needs OAuth (not served yet) |
| Cursor | ✓ | ✓ | ✓ | ✓ | ✓ | ✕ | ✕ | `~/.cursor/mcp.json` with header auth |
| Grok | ✓ | ✓ | ✓ | ✓ | ✓ | ✕ | ✕ | limited — xAI Remote MCP Tools for API/agents; consumer surfaces vary (see `integrations/grok/README.md`) |
| Perplexity | ✓ | ✓ | ✓ | ✓ | ✓ | ✕ | ✕ | limited — custom remote connectors; Bearer or proxy-injected key |
| ChatGPT | ✓ | ✕ | ✕ | ✓ | ✓ (read) | ✕ | ✕ | limited — Developer Mode custom connector; key enforced at the proxy |

Rules this matrix follows:

- **Write/update for ChatGPT is false because the platform has no API-key
  slot** — DAMC never serves an unauthenticated endpoint, so no workaround is
  faked. When a key-carrying path exists, the same gateway serves write with
  zero DAMC changes.
- **Live sync / push are false for everyone.** No consumer chat API offers
  provider-initiated history sync or message injection; the honest equivalent
  is the client calling DAMC tools (session/context capabilities).

## Connection status (what the Sync Center shows)

Derived from real evidence — the API keys that exist and the content-free MCP
audit trail (`audit_logs.action='mcp.tool_call'`: client, tool, outcome, time,
project uuid; never memory content):

| Status | Meaning |
|---|---|
| `NOT_CONFIGURED` | no API key yet — nothing to connect with |
| `CONFIGURED` | a key exists; no handshake from this client seen yet |
| `AUTHENTICATED` | this client completed an MCP handshake, but never called a tool — connected, unused |
| `READ_READY` | reads/context/session pulls seen, no writes yet |
| `WRITE_READY` | writes seen, none in the last 24 h |
| `ACTIVE` | tool calls from this client within the last 24 h |
| `ERROR` | reserved for surfaced failures |
| `NOT_SUPPORTED` | no platform path at all |

Each AI card also shows **Last read / Last write / Last context / Last
session / Tool calls** from the same audit trail. "Connected" without usage
renders as `AUTHENTICATED`, never as `ACTIVE`.

## Recent memory activity

`GET /v1/activity/mcp?limit=20` returns the newest-first feed of real MCP
tool calls — `{ at, client, tool, projectId, projectName, kind, ok }`,
content-free by construction (only the project uuid is logged; the name
resolves server-side at read time). The Sync Center renders it as the
"Recent memory activity" card. Empty means no AI has touched memory through
the gateway yet.

## Test Memory (per AI card)

Not a health ping: a live `context_pack` read plus memory totals, reported
with the counts the backend actually returned (decisions, tasks, memories).
Failures surface the real error. The shared skill behind every setup is
served byte-identical at `GET /v1/connectors/skill`.

## Multi-user isolation

A gateway key resolves to exactly one `user_id`; every memory query is scoped
by it. Two keys on one DAMC instance see two disjoint memories
(`tests/mcp-tools-e2e.test.ts` covers the cross-user negative case).
