# DAMC 1.2.0 — Common Memory Hub — Release Notes

DAMC is no longer "an AI memory store". It is the **Common Memory Hub**: ChatGPT,
Claude, Grok, Perplexity and Cursor read and write **one shared memory** through
one MCP gateway. No AI talks to another AI — every AI talks to DAMC, and DAMC
is the single source of truth.

## The A → B → C flow that now works

1. Run DAMC, create a project (AI Connections → first-run onboarding).
2. Create an API key (shown once; only a hash is stored).
3. Pick an AI, copy its setup from `integrations/<ai>/` (or the Sync Center
   Setup dialog), connect it to `POST /mcp`.
4. That AI calls `session_start` → works → `decision_create` / `task_create` /
   `memory_create` → `session_save`.
5. A different AI calls `session_start` for the same project and continues —
   decisions, tasks, constraints and provenance included.

## What is in this release

**Remote MCP gateway.** `POST /mcp` (MCP Streamable HTTP): Bearer API-key auth
mandatory even in dev mode, per-key rate limiting, 1 MiB body limit, user_id
scoping on every query. `POST /v1/mcp` stays as the local surface.

**Common memory tools (22).** Read, context, write, decisions, tasks, session
handoff (`session_start` / `session_context` / `session_save`) and meta — all
delegating to the existing memory engine (dedup, restate, supersession,
provenance, Korean classification untouched).

**Sync Center.** Per-AI cards with real connection states (`NOT_CONFIGURED` →
`CONFIGURED` → `AUTHENTICATED` → `READ_READY` / `WRITE_READY` → `ACTIVE`),
Last read/write/context/session, Test Memory (a real context-pack read, never
a canned success), recent memory activity feed, Remote Access publishing, and
the API-key manager (create once-shown secret, list, revoke).

**Setup packs.** `integrations/chatgpt|claude|grok|perplexity|cursor/` each with
`README.md`, `SETUP.md`, `CONFIG.md` (copy-ready) and `DAMC_SKILL.md` (the
shared memory rules every AI follows).

## Known limitations (platform, not DAMC)

- ChatGPT: read/context available; write/update platform-limited (no API-key
  slot in its connector setup — auth is enforced at the proxy).
- Claude.ai web connectors need OAuth 2.1 (not served); use Claude Code or the
  Desktop bridge.
- Grok / Perplexity: limited — only MCP-capable tooling connects; consumer
  surfaces without MCP are not clients.
- Live sync and push are not supported for any provider: no consumer chat API
  offers them, and DAMC does not fake them.
- Semantic embeddings remain an abstraction; retrieval is PostgreSQL
  full-text search with a substring fallback.

---

# DAMC 1.0.0 — Release Notes (kept for history)

DAMC (Dalur AI Memory Center) is a provider-independent long-term memory layer.
It runs entirely on your machine and is reachable only from your machine.

## Install

1. Install and start **Docker Desktop** — <https://www.docker.com/products/docker-desktop/>
2. Run `DAMC_Setup.exe`
3. Start DAMC from the Start menu, or let the installer start it

The DAMC application image and PostgreSQL are bundled in the installer, so the
first start needs no download.

Dashboard: <http://127.0.0.1:8787>

## What is in this release

**Memory store.** PostgreSQL-backed memories with full provenance: every memory
keeps the provider, source and conversation it came from. Memories have a
lifecycle — candidate, confirmed, active, superseded, deprecated, archived — and
old versions are never destroyed.

**Web dashboard.** Eight screens served by the backend itself: Overview, Memory,
Current State, Graph, Connections, Import, Sync and Settings. Static HTML, CSS
and ES modules, no framework. It falls back to clearly-labelled demo data when
no backend answers, and refuses writes in that state rather than faking them.

**Import.** Official ChatGPT and Claude export files, JSON or ZIP, with a
parse-only preview before anything is written. Import is idempotent.

**Korean-aware decision detection.** Decisions and tasks are recognised in
Korean as well as English, including explicit change declarations
("배포 방식은 Kubernetes로 변경했다"). Questions, hedges, definitions and
statements of intent are deliberately not treated as decisions.

**Decision supersession.** A new decision about the same subject *and* the same
dimension supersedes the previous one: the old row becomes superseded with a
validity end, the new one becomes active and records what it replaced, a
SUPERSEDES relation is stored, and the previous content is preserved as a
version. A deployment *method* and a deployment *date* are kept apart.

**MCP boundary.** `POST /v1/mcp` exposes a `damc_context` tool over JSON-RPC.

## Security and privacy

DAMC never stores provider passwords, never reads browser cookies or session
tokens, never calls private APIs and never bypasses CAPTCHAs. Conversation
history enters only through official export files.

Both ports bind to `127.0.0.1`, so nothing on your network can reach DAMC.
Because it is local and single-user, the API runs without an API key. If you
expose DAMC on any other interface, set `DAMC_DEV_MODE=false` in
`docker-compose.yml` and issue an API key first.

## Your data

Memories live in the Docker volume `damc_damc_pg`. Stopping DAMC, restarting
Windows and uninstalling all keep it. Uninstall asks separately — and defaults
to keeping your data — before removing anything.

## Known limitations

- Semantic embeddings are an abstraction only; retrieval is PostgreSQL
  full-text search with a substring fallback.
- Memory extraction is heuristic. Extracted items arrive as candidates and are
  never silently promoted to confirmed facts; only DECISION becomes active
  automatically.
- There is no multi-user authentication. DAMC is a local single-user product.
- Obsidian export is one-way. Reading edits back from a vault is not implemented.
- GitHub backup requires host git credentials and is off by default.
- Live account sync with ChatGPT or Claude does not exist and is never shown as
  connected.
