# DAMC Remote MCP Gateway

DAMC exposes one published MCP endpoint for every AI client, local or remote:

```
POST {base}/mcp
```

- **Transport**: MCP Streamable HTTP (single endpoint, `POST` JSON-RPC in,
  single `application/json` JSON-RPC response out). Server-initiated SSE
  (`GET`) and session termination (`DELETE`) answer `405` — this gateway is
  stateless, which the transport spec explicitly permits. JSON-RPC batches are
  rejected: current clients send single messages and batching would bypass
  per-message validation.
- **Protocol**: `2025-06-18` (echoed when the client requests `2025-03-26`).
- **Auth**: always required — `Authorization: Bearer damc_…` (a DAMC API key).
  **Dev mode is never honored here.** `/v1/mcp` remains the local, dev-mode
  convenience surface; `/mcp` is the published one.
- **Rate limit**: token bucket per API key, `DAMC_MCP_RATE_LIMIT_PER_MINUTE`
  (default 120/min). 429 responses carry `Retry-After`.
- **Body limit**: 1 MiB per request.

The tool surface is byte-identical to the local surface: 22 tools delegating to
the same memory engine (see `docs/DAMC_MULTI_AI_CONNECTOR.md`). A key's
`user_id` is the only memory scope the gateway can see — user isolation is the
existing `user_id` scoping on every table, now with real credentials behind it.

## Tool surface

| Group | Tools |
|---|---|
| Read | `memory_search`, `memory_get`, `project_memories`, `decision_search`, `active_decisions`, `task_search` |
| Context | `context_pack` (project state), `damc_context` (query-driven, kept for 1.0.0 clients) |
| Write | `memory_create`, `memory_update`, `memory_restate` |
| Decisions | `decision_create`, `decision_update` (explicit supersede), `decision_supersede` (retire) |
| Tasks | `task_create`, `task_update`, `task_status` (explicit only — never auto-completed) |
| Session | `session_start`, `session_context`, `session_save` |
| Meta | `server_info`, `health` |

Write policy (enforced in `src/connectors/mcp/write-policy.ts`): every write is
scanned for credentials/tokens/private keys/JWTs/connection strings and
rejected by name without echoing the match. `session_save` additionally applies
the auto-record bar (30-char floor + classification): chatter is skipped, clear
decisions/tasks/knowledge are stored. DAMC never stores secrets, from any
client, through any tool.

## Publishing over HTTPS (remote clients)

Loopback works for same-machine clients (Claude Code, Cursor). Cloud-hosted
clients (ChatGPT connectors, Claude.ai, Grok, Perplexity) need a public HTTPS
origin. DAMC never opens a raw port to the internet; TLS and the API key sit
in front of the loopback server. Three paths, most stable first:

### Named tunnel (stable hostname — the production path)

1. Once, on any machine with cloudflared: `cloudflared tunnel login`,
   `cloudflared tunnel create damc`, route your hostname to it
   (`cloudflared tunnel route dns <tunnel-id> memory.<domain>`).
2. Give DAMC the token (tunnel overview → Configure → token) and hostname:
   `DAMC_TUNNEL_TOKEN=<token>` + `DAMC_TUNNEL_HOSTNAME=memory.<domain>`.
3. AI Connections → **Remote Access** → *Enable*. DAMC runs
   `cloudflared tunnel run` itself (token travels in the child environment
   only — never argv, logs, or API responses) and advertises the stable
   `https://memory.<domain>` endpoint. It survives restarts; the choice
   persists and the tunnel is re-established on boot.

### Remote Access quick tunnel (built-in, one toggle, ephemeral)

AI Connections → **Remote Access** → *Enable*. If `cloudflared` is installed,
DAMC starts a managed quick tunnel (`cloudflared tunnel --url
http://127.0.0.1:8787`) and displays the resulting
`https://<random>.trycloudflare.com` endpoint; the choice persists and the
tunnel is re-established on boot. Set `DAMC_CLOUDFLARED_PATH` if the binary is
not on PATH. A quick tunnel's URL changes whenever it restarts — that is
inherent to ephemeral tunnels; the UI always shows the current one, and
`damc ai repoint --apply` moves the local Claude/Cursor registrations to it
(keys preserved, backups taken).

Quick tunnels terminate TLS at the edge and do not authenticate. The gateway
itself still requires the API key, so nothing is exposed unauthenticated — but
for hosts whose connector UI cannot send the key (ChatGPT), enforce it at your
own proxy instead (below).

### Own endpoint (reverse proxy / named tunnel)

1. Reverse proxy (Caddy/nginx) or a named Cloudflare tunnel in front of
   `127.0.0.1:8787`, TLS-terminating at the proxy.
2. Set `DAMC_PUBLIC_URL=https://<your-host>` so generated configs and the
   dashboard show the published origin.
3. Keep `/mcp` behind the API key. Do **not** strip the `Authorization` header
   at the proxy; do not run a second unauthenticated path.

`POST /v1/remote-access/verify` (and the UI's *Verify endpoint* button) probe
the configured endpoint's `/health` and confirm it answers as DAMC. Each probe
is persisted as last-reachable evidence (`lastVerifiedAt` / `lastVerifyOk`)
shown in the Sync Center next to the endpoint.

### Known platform limitations (honest capability map)

| Client | Read | Write | Update | Context | Session | Constraint |
|---|---|---|---|---|---|---|
| Claude Code | ✓ | ✓ | ✓ | ✓ | ✓ | none — header auth supported natively |
| Cursor | ✓ | ✓ | ✓ | ✓ | ✓ | none — remote MCP + headers supported |
| Grok | ✓ | ✓ | ✓ | ✓ | ✓ | xAI Remote MCP Tools (docs.x.ai); consumer surfaces without MCP are not clients |
| Claude Desktop | ✓ | ✓ | ✓ | ✓ | ✓ | via `mcp-remote` bridge (stdio-only host) |
| Perplexity | ✓ | ✓ | ✓ | ✓ | ✓ | custom remote connectors; OAuth-leaning flow may need proxy-injected key |
| Claude.ai custom connectors | — | — | — | — | — | host requires OAuth 2.1; DAMC does not serve OAuth yet |
| ChatGPT connectors | ✓* | ✕ | ✕ | ✓* | ✓ (read) | no API-key field; auth must be enforced at the proxy; *write needs a key-carrying path |

Live sync (provider-initiated history sync) and push (injecting messages into
a provider's chat) are false for every provider — no consumer chat API offers
them. These are host-side constraints: the gateway serves the same contract to
everyone, and when a host adds credential support its row changes without any
DAMC-side work. The dashboard's AI Connections section renders exactly this
map from `GET /v1/connectors/capabilities` (`aiClients[]`).

## Multi-user foundation

`users → projects → memories` scoping is enforced end to end (every table keys
on `users(id)`, every query filters `user_id`). The gateway adds the missing
piece — per-user credentials — so two keys on one DAMC instance see two
disjoint memories. Team/role layers can later slot in above `users` without
touching this surface.

## Future OAuth/OIDC (structure, not a claim)

Today the gateway speaks API keys only, and every provider card says so —
there are no OAuth discovery endpoints and no fake OAuth flow anywhere. If a
future release serves OAuth/OIDC, it plugs into exactly one seam, and nothing
else changes:

- `src/http/auth.ts` `authenticate()` (loopback `/v1`) and
  `src/http/mcp-gateway.ts` `authenticateGatewayRequest()` (`/mcp`) are the
  only two functions that turn credentials into a `user_id`. An OAuth issuer
  would add a third resolver (validate JWT → `sub` → `users.id`) beside
  `resolveApiKey`, behind the same per-key rate limit and the same user
  scoping. Tools, engines, audit rows and the Sync Center need no changes:
  they already see only `user_id`.
- Until that lands, hosts that require OAuth-shaped connectors (ChatGPT
  Developer Mode, Claude.ai custom connectors) stay honestly labeled
  `limited` / `NOT_SUPPORTED` with the proxy-auth path documented per pack.

## Local development

- `POST /v1/mcp` — unchanged local surface (dev mode allowed, no rate limit).
- `POST /mcp` — the gateway; use it to test exactly what a remote client sees.
- `GET /v1/connectors/mcp/tools` — plain-JSON tool list.
- `GET /v1/connectors/skill` — the shared DAMC skill text (`{ path, content }`), byte-identical to `integrations/SKILL.md`.
- `GET /v1/activity/mcp` — newest-first feed of real tool calls
  (`{ at, client, tool, projectId, projectName, kind, ok }`, content-free:
  only a project uuid is logged, the name resolves server-side at read time);
  what the Sync Center's "Recent memory activity" card renders.
