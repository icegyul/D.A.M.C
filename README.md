# DAMC — Dalur AI Memory Center 1.2.0

DAMC is a provider-neutral shared memory layer for ChatGPT, Claude and other AI
agents. One PostgreSQL database holds the memory; every AI client reads and
writes the same records through MCP or the REST API.

## Included
- Fastify + TypeScript API (`/health`, ~39 routes under `/v1`)
- PostgreSQL schema + migrations (`migrations/`, applied by `npm run db:migrate`)
- ChatGPT / Claude official export ingestion (JSON + ZIP)
- Idempotent conversation ingestion and memory extraction
- Memory lifecycle: candidate → active, supersession, version history, provenance
- Promotion gate: an extraction that only *implies* a decision stays a candidate
- Bilingual (Korean/English) decision detection and subject matching
- Korean-capable retrieval: full-text plus trigram substring search
- Current State builder and project-scoped Context Pack
- Relation graph API
- Obsidian Markdown export (adapter)
- GitHub backup (adapter, per-user paths)
- API-key authentication + loopback-scoped dev mode
- MCP: 22 tools over local `POST /v1/mcp` and the authenticated remote gateway `POST /mcp`
- Remote Access via a managed cloudflared tunnel or your own HTTPS endpoint
- Watch-folder import (drop an export file in a folder, it imports itself)
- Zero-password/cookie scraping architecture
- Built-in vanilla web dashboard wired to the real API (LIVE / DEMO fallback)

## Start

Full stack in Docker (how DAMC ships):

```bash
docker compose up -d
```

Then open `http://localhost:8787`. Migrations run inside the container on start.

For development against a local Node process:

```bash
cp .env.example .env
docker compose up -d db
npm install
npm run db:migrate
npm run dev
```

## Tests

```bash
npm test
```

Three test files need PostgreSQL and skip themselves when it is unreachable, so a
green run does not by itself prove the persistence layer was exercised. In CI, or
before declaring a release, require them:

```bash
DAMC_REQUIRE_DB=1 npm test
```

That turns a missing database into a failure instead of a silent skip. The suite
uses an isolated `damc_test` database (`CREATE DATABASE damc_test OWNER damc`),
never the one the running stack uses.

## Provider reality
DAMC deliberately does not scrape consumer ChatGPT/Claude sessions. Historical
data enters through official provider exports. Live AI access is provided through
the MCP boundary when the provider/plan supports remote MCP or apps.

### Claude export packages
Claude's "Export your data" no longer produces one `conversations.json`. It
produces a small manifest JSON listing several category ZIPs, each behind a
download URL that works exactly once. Upload that manifest and DAMC recognises it:

Because `claude.ai` answers a server-side download with a bot-protection page —
and DAMC will not work around that — **the download happens in your browser**,
which is what Claude's own instructions say to do:

- The dashboard parses the manifest locally. Every `export_url` stays in that
  browser tab: none is sent to the server, stored, or logged.
- `POST /v1/import/claude/manifest/session` opens a session from the package list
  (category, filename, part — no URLs). Each package gets a "download in your
  browser" button, offered one at a time, and never again once its file arrives.
- The downloads land in the watch folder (`C:\DAMC_IMPORT`), where the existing
  watcher matches each file to its package and imports or retains it. Nothing about
  the import pipeline changed.
- `POST /v1/import/claude/manifest/preview` describes a manifest without touching a
  link.
- `POST /v1/import/claude/manifest` still downloads server-side for any host that
  serves the file, constrained by `DAMC_CLAUDE_DOWNLOAD_HOSTS` on every redirect
  hop. A blocked attempt parks the job at `awaiting_download` with every link
  unused rather than reporting a failed import.

Only the `conversations` category is parsed. `memories`, `projects`,
`design_chats` and `light_metadata` are kept on disk with their real entry
listings recorded, and are not mapped — DAMC does not invent a field mapping for a
structure it has not seen. `docs/CLAUDE_EXPORT_CATEGORIES.md` has the evidence and
the disposition per category, including why `claude.ai` currently refuses a
server-side download and what DAMC does instead.

## Dashboard
The dashboard at `/` is static HTML/CSS/ES modules served by the backend.
It reads live data when the backend answers `GET /health`, and falls back to a
clearly-labelled DEMO dataset when it does not. In DEMO mode every write is
refused rather than simulated. See `docs/WEB_DASHBOARD.md`.

## Authentication
`/health` and the dashboard assets are public. Everything under `/v1` needs
either `Authorization: Bearer <api key>` or dev mode.

Dev mode (`DAMC_DEV_MODE`, on by default) resolves an unauthenticated request to a
fixed local user so the bundled dashboard works on a fresh install with no key to
paste. **It only ever applies to requests that originate on this machine.** A
request that arrives through a proxy or tunnel — anything carrying
`X-Forwarded-For`, `CF-Connecting-IP` or a sibling header — must present an API
key regardless of the flag, so publishing DAMC through Remote Access cannot
expose `/v1` by leaving dev mode on. `X-DAMC-User-Id` is scoped the same way.

The remote MCP gateway (`POST /mcp`) always requires an API key, dev mode or not,
and is rate-limited per key.

Create a key from the dashboard (Sync Center → API keys) or
`POST /v1/auth/api-keys`.

One caveat worth knowing: a peer on your LAN is indistinguishable from the Docker
host at the socket level. `docker-compose.yml` binds `127.0.0.1`, so this does not
arise by default — but if you republish the port on a LAN interface, set
`DAMC_DEV_MODE=false` and use keys.

`CORS_ORIGIN` is empty by default, which means same-origin only. The bundled
dashboard is same-origin and unaffected; set a comma-separated origin list to
allow a specific web app.

## API
See `docs/API_EXAMPLES.md` and `docs/CONNECTOR_STRATEGY.md`.

## License
MIT — anyone may use, modify and redistribute DAMC, including commercially.
See [LICENSE](LICENSE).

MIT 라이선스입니다. 누구나 자유롭게 사용·수정·배포할 수 있습니다.

DAMC ships no memory data. Your imported conversations and memories live in your
own PostgreSQL database and `storage/` directory, both of which are git-ignored.
