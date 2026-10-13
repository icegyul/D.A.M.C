# DAMC — Claude Code Working Rules

## Product
DAMC = Dalur AI Memory Center. It is the provider-independent long-term memory
layer: one PostgreSQL database that Claude, ChatGPT, Cursor and other AI clients
all read from and write to, over MCP and a REST API.

## Non-negotiable
- Do not implement password storage, browser cookie extraction, CAPTCHA bypass, or unofficial ChatGPT/Claude scraping.
- Provider-specific access must remain behind connector interfaces.
- Preserve raw source provenance.
- Do not destroy old memory versions; use supersession/versioning.
- Do not silently turn AI-extracted candidates into confirmed facts.
- Keep GitHub backup and Obsidian export as adapters, not the core database.

## Where those rules live in code
The invariants above are enforced, not just documented. Change these with care:

- `src/services/promotion-gate.ts` — the candidate → active bar. An extraction
  that only *implies* a decision (`evidence: 'inferred'`, graded in
  `text-classification.ts`) is stored as `candidate` and may not supersede
  anything. A contradiction it is not allowed to resolve becomes a
  `CONFLICT_PENDING` candidate plus a `CONFLICTS_WITH` relation, so both sides
  survive for review.
- `src/db/pool.ts` (`withTransaction`) — every multi-statement memory write runs
  as one transaction. Calling the module-level `query` four times is four
  autocommits on four connections: use `withTransaction` for anything that
  writes more than one row, and note that `SELECT … FOR UPDATE` only holds a lock
  inside one.
- `src/services/memory-engine.ts` — supersession. Never retire a memory without
  writing its version row and the `SUPERSEDES` relation in the same transaction.
- `src/http/auth.ts` — dev mode grants an unauthenticated identity only to
  requests that originate on this machine. Locality is decided by forwarding
  headers, not by socket address: cloudflared runs inside the container, so
  tunnelled traffic arrives from 127.0.0.1.
- `src/db/migrator.ts` — one migration, one transaction, under an advisory lock.
- `src/services/import-upload-service.ts` — a large upload is streamed to a temp
  file, never `toBuffer()`d. Read the module note before touching it: when the
  size limit is hit, busboy ends the stream *cleanly* and the pipeline resolves,
  so only `part.file.truncated` distinguishes a complete upload from a truncated
  one. Dropping that check turns an over-limit upload into a silent HTTP 200 with
  half a file on disk.
- `src/lib/json-stream.ts` — conversations.json is read one array element at a
  time. Never `JSON.parse` an export whole: past ~1 GB it exceeds V8's maximum
  string length, and the object graph costs several times the text.
- `src/services/claude-download-service.ts` — fetches URLs that came out of a
  file the user uploaded, which is an SSRF primitive. Redirects are followed by
  hand so every hop is re-validated against the host allowlist; `redirect:
  'follow'` would chase a `Location` into the private network before this module
  saw it. A full `export_url` is a bearer credential and is never logged.
- `src/services/claude-package-service.ts` — the browser-download session. Two
  invariants: an `export_url` never reaches the server on this path (the page holds
  them and posts only the package list — `planFromEntries` refuses a body that
  contains one), and an archive is routed by its own entry listing rather than by
  the category name the manifest gave it. The session job's status is
  `awaiting_download`, deliberately outside the `('running','queued')` set that
  `failInterruptedImports` fails at boot: a session waits on a human across
  restarts.
- `src/http/auth.ts` (`mayBootstrap`) — the one moment DAMC issues an API key
  without one: a request from this machine, on an install that has no live key yet.
  Both conditions are necessary and the window closes permanently once a key exists.
  This is what lets the shipped configuration run with `DAMC_DEV_MODE=false`; do not
  widen it, and do not count revoked keys as live (revoking your only key has to
  leave a way back in).
- `src/services/ingestion-service.ts` (`detectProjectHint`) — a keyword match here
  creates a real `projects` row in the user's database. The keywords are
  configuration (`DAMC_PROJECT_HINTS`), never a constant: they were once the
  developer's own project names, compiled into every shipped copy.
- `tests/production-readiness.test.ts` and `tests/clean-install.integration.test.ts`
  — the only tests that can fail on "the product ships no sample data", "a fresh
  database is empty", and "the shipped compose does not run in dev mode". Nothing
  else in the suite covers them.
- `src/services/claude-category-service.ts` — only `conversations` is parsed. The
  other export categories are kept with their real entry listings recorded and
  deliberately left unmapped. Do not add a category to `IMPORTABLE_CATEGORIES`
  without an observed archive and a parser written against what was in it; see
  `docs/CLAUDE_EXPORT_CATEGORIES.md`.

## Development order
1. Connector feasibility
2. Ingestion / normalization
3. Memory lifecycle
4. Retrieval
5. Graph
6. AI shared context / MCP
7. GitHub backup
8. Obsidian sync
9. Web UI

## Testing
`npm test` runs the whole suite. Five files need PostgreSQL and skip themselves
when it is absent, which means a green run can hide the fact that persistence was
never exercised — use `DAMC_REQUIRE_DB=1 npm test` to make that a failure. The
database-backed files share an isolated `damc_test` database and apply migrations
through the same runner production uses.

Do not weaken or delete an existing test to make a change pass.

## Current limitations
- Import reads an export as a stream (upload -> temp file -> ZIP entry -> one
  conversation at a time), so memory does not scale with export size; verified at
  2.05 GB with peak container memory under 1 GiB. The caps in
  `DAMC_IMPORT_MAX_*` bound disk and reject hostile archives, not memory.
- Semantic embeddings are an abstraction only; retrieval is lexical (PostgreSQL
  full-text) plus trigram substring matching. There is no vector search.
- Korean retrieval relies on trigram indexes (`migrations/005`) because
  `to_tsvector('simple', …)` cannot split an agglutinative token from its
  particle. There is no Korean morphological analyser.
- ChatGPT/Claude connectors are export-oriented adapters; real account sync
  requires official access validation.
- GitHub backup writes each user under `users/<user id>/` and redacts credentials
  out of responses and errors, but a shared backup repository is still shared:
  anyone who can read it reads every user's export.
- Dev mode trusts private-network source addresses, because that is how a
  containerised deployment is reached. A LAN peer is therefore indistinguishable
  from the Docker host; publish on loopback, or set `DAMC_DEV_MODE=false`.
- The release bundle (`release/`) is assembled by hand — there is no packaging
  script — and contains a prebuilt Docker image tar that does not update when
  `npm run build` runs.

DAMC 1.2.0: backend API + built-in web dashboard + JSON/ZIP official export
ingestion + 22-tool MCP surface (local and authenticated remote gateway).
