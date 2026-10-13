# DAMC AI Connector Packs

Pack version: **1.1.0** (`PACK_VERSION` — the dashboard's connector status
reports the same version, so mismatches are visible, not silent).

One gateway, one memory, five clients. Every AI here talks to the **same**
DAMC memory through the **same** remote MCP gateway:

```
POST {your-damc-host}/mcp        (MCP Streamable HTTP transport)
Authorization: Bearer damc_…     (DAMC API key — create it in the dashboard)
```

Per-pack: `README.md` (capabilities + overview) · `SETUP.md` (step-by-step) ·
`CONFIG.md` (copy-ready config) · `DAMC_SKILL.md` (shared memory rules,
identical in every pack).

| Pack | Platform | Read | Write | Update | Context | Session | Live sync | Push |
|---|---|---|---|---|---|---|---|---|
| [ChatGPT](./chatgpt/README.md) | limited — Developer Mode connectors, no API-key slot | ✓ | ✕ | ✕ | ✓ | ✓ (read) | ✕ | ✕ |
| [Claude](./claude/README.md) | available — Claude Code / Desktop bridge | ✓ | ✓ | ✓ | ✓ | ✓ | ✕ | ✕ |
| [Grok](./grok/README.md) | limited — no official consumer MCP surface; xAI Remote MCP Tools for API/agents | ✓ | ✓ | ✓ | ✓ | ✓ | ✕ | ✕ |
| [Perplexity](./perplexity/README.md) | limited — custom remote connectors, OAuth-leaning flow | ✓ | ✓ | ✓ | ✓ | ✓ | ✕ | ✕ |
| [Cursor](./cursor/README.md) | available — remote MCP with header auth | ✓ | ✓ | ✓ | ✓ | ✓ | ✕ | ✕ |

"limited" is a statement about the provider's platform, not about DAMC: the
gateway serves identical tools to everyone, and DAMC never runs an
unauthenticated endpoint. **Live sync** (provider-initiated history sync) and
**push** (injecting messages into a provider's chat) are false everywhere — no
consumer chat API offers them, and DAMC does not fake them. The real product
path to "the AI always uses fresh memory" is the client calling DAMC tools,
which is the session/context capability.

## The universal 4-step flow

1. **Create an API key** — DAMC → AI Connections → API keys → *Create API Key*. The raw key is shown once.
2. **Publish DAMC** (remote clients only) — AI Connections → **Remote Access** (one toggle with cloudflared, or `DAMC_PUBLIC_URL` + your proxy). Loopback is enough for same-machine clients.
3. **Register the server** in the client — copy the config from the pack, replacing `<YOUR_DAMC_API_KEY>`.
4. **Verify** — ask the client: *"Use DAMC session_start for my project."*

Shortcut for the two local clients — one command from the DAMC project folder
(dry-run first, `--apply` writes; existing files are backed up, never
blindly overwritten):

```cmd
damc ai setup claude --apply
damc ai setup cursor --apply
damc ai skill cursor --apply --project <your-project-dir>
damc ai context <your-project>
damc ai status
```

If the public tunnel URL rotated (quick tunnels do on restart), move the
local registrations without touching keys: `damc ai repoint --apply`.
Named tunnels (`DAMC_TUNNEL_TOKEN`, see `docs/PRODUCTION_DEPLOYMENT.md`)
keep one stable hostname instead.

## Cross-AI flows (all real, all through DAMC)

**FLOW 1 — Claude decides, Cursor continues**
Claude → `session_start(DAMC)` → work → `decision_create("배포 방식은 Kubernetes로 변경")` — DAMC supersedes the old Docker decision automatically.
Cursor → `session_start(DAMC)` → Context Pack already shows the Kubernetes decision as active, the Docker one as superseded, with both AIs in provenance.

**FLOW 2 — Cursor updates a task, Claude picks it up**
Cursor → `task_update(status: active)` → Claude → `task_search` sees the new status and Cursor's client id on the version.

**FLOW 3 — Grok writes, Perplexity reads**
Grok (xAI Remote MCP) → `memory_create(research finding)` → Perplexity tooling → `memory_search` returns it with `provider: grok`.

**FLOW 4 — ChatGPT reads the latest state**
ChatGPT (custom connector) → `context_pack` → answers from the current active decisions — including ones written by Claude, Cursor or Grok. ChatGPT's write path stays off (platform limit); everything else it reads is live shared memory.

## The shared usage loop (identical for every AI)

1. `session_start` (or `context_pack`) — load active decisions, open tasks, constraints, provenance.
2. Work. When something settles, `decision_create` / `task_create` / `memory_create`.
3. When a decision changes, `decision_update` (or let `decision_create` supersede automatically).
4. `session_save` before the conversation ends — DAMC classifies, dedups, refuses secrets.

The same rules in client-readable form live in [SKILL.md](./SKILL.md) (and per-pack as
`DAMC_SKILL.md`) — paste it into any client's system prompt / rules file so every AI
uses identical memory semantics.
