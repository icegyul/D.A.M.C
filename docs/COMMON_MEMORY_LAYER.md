# DAMC Common Memory Layer

## 1. The idea

DAMC is not a per-AI chat backup tool. It is the one memory a person's AI
work accumulates into, regardless of which AI produced it:

> Change the AI, the memory stays. ChatGPT and Claude are clients of DAMC's
> memory — DAMC does not become a client of theirs.

This document covers what changed to make that literal: memories from
different providers that say the same thing merge instead of duplicating, a
Context Pack summarizes what DAMC knows in one bounded shape, and a provider
can be turned on/off without ever touching what it already imported.

Nothing here replaces the import pipeline built earlier (web upload / CLI /
watch folder / dedup / job tracking — see `docs/IMPORT_AUTOMATION.md`) or the
classification and supersession engine (Korean DECISION/TASK detection,
decision dimension matching). Every piece below calls into that same
pipeline; none of it is a second one.

## 2. Provider capability model

`ConnectorCapabilities` (`src/connectors/types.ts`) is the single source of
truth the UI, the Connections page and this document all read from. Every
field is a claim someone will act on, so each one is pinned to what the
provider's *official* surface actually offers today — not what would be nice:

| Field | ChatGPT / Claude today | Why |
|---|---|---|
| `import` | **true** | Official export file, parsed and ingested through the normal pipeline. |
| `manualSync` | **true** | Web upload, CLI, and the watch folder are all operator/file-triggered. |
| `autoSync` | **false** | Neither provider pushes or pulls data on its own. The watch folder's automation is real, but it is DAMC watching a folder, not the provider doing anything — reported separately as `watchFolder`, never folded into a provider's own capability. |
| `liveSync` | **false** | No official API exists for a third party to hold a live, continuously-updated view of a consumer account's conversation history. |
| `contextExport` | **true** | The Context Pack (§4) can be generated and handed to either provider. |
| `contextPush` | **false** | No API exists to push a context block directly into a ChatGPT or Claude conversation. |
| `oauth` | **false** | There is nothing to authorize — DAMC never requests access to the account. |

Section 27 of the directive this was built against put it plainly: if a
provider does not offer a capability, DAMC does not claim it, however
convenient the claim would be for the UI. `NOT_SUPPORTED` is a real value a
caller can get back (from `connectProvider`/`disconnectProvider` on an
unlisted provider), not a placeholder that was never wired up.

## 3. Connect / disconnect — what it actually is

There is no OAuth flow to run, so "connect" cannot mean an account session.
It means exactly one thing: **DAMC's own local pipeline for that provider is
turned on**, persisted in the `connectors` table (unchanged since v0.1 —
`migrations/001_init.sql`, no new migration). `disconnectProvider` only ever
writes to that one table — it has no code path that touches `memories`,
`conversations`, `sources` or `relations`, so history already imported can
never be lost by disconnecting (`tests/common-memory.integration.test.ts`
asserts row counts are unchanged across a disconnect).

Attempting to connect/disconnect anything other than `chatgpt`/`claude`
throws `NotSupportedError` (HTTP 400, code `NOT_SUPPORTED`) rather than
silently succeeding — see `src/services/connector-connection-service.ts`.

`GET /v1/connectors/capabilities` already showed this distinction before this
feature existed (its `note`/`policy` text has always said DAMC never
represents a provider as a live connection); the Connections page's own
"연결됨" copy is worded to keep saying exactly that, redefined rather than
walked back: connected = local pipeline on, never an account session.

## 4. Cross-provider Common Memory

### Restatement merge

The same fact said in different words by different providers is one Common
Memory, not two — but the definition of "different words" is bounded, not a
new NLP layer: it reuses `extractDecisionSubject`/`linkDecisionSubjects`/
`decidesDifferently` exactly as they already existed for detecting
supersession (`src/services/decision-topic.ts`, unchanged). `upsertMemoryCandidate`
(`src/services/memory-engine.ts`) now branches three ways for a DECISION/RULE/CONSTRAINT
candidate against a related active memory found by the existing SQL pre-filter:

```
same subject + different value   -> SUPERSEDE (unchanged from before)
same subject + same value        -> RESTATE    (new)
no related memory found          -> CREATE     (unchanged)
```

RESTATE creates **no new memory row**. It adds a version to the memory that
already exists (`memory_versions`, unchanged table) carrying the new
statement's own `source_id` — so the Common Memory keeps one canonical
record while `getMemoryDetail` and the Context Pack can show every provider
that ever said it. This is the whole feature: no schema change, no new
matching heuristic, just recognizing a case the old code silently discarded
into a duplicate memory instead of using it as corroborating provenance.

### Provenance across providers

`memory_versions.source_id` already existed; it just was not surfaced with
which provider it came from. `getMemoryDetail`'s version query now joins
`sources.provider` onto each version (`src/repositories/memory-repository.ts`),
and the Context Pack's `provenance.restatedBy` list is built the same way
(`src/services/context-pack-service.ts`). A memory's `providers` array and
`crossProvider` flag are computed from exactly this: the memory's own source
plus every version's source, deduplicated.

### Supersedes across providers

This required no code change at all: `memories` has never had a `provider`
column — provider is only reachable by joining through `sources`/`conversations`
— and the SQL that looks for a conflicting decision to supersede
(`upsertMemoryCandidate`) has never filtered by provider, only by
`user_id`/`type`/`status`/`project_id`. A ChatGPT decision was already
supersedable by a later Claude statement before this feature existed.
`tests/common-memory.integration.test.ts` adds an explicit test for this
specifically, because "already worked" is a claim worth checking, not
assuming.

### A latent version-numbering bug this surfaced

Repeated restate/supersede tests against the same memory exposed that
`memories.version` was never actually incremented anywhere outside
`setMemoryStatus` — `addVersion` was always called with a version number
computed from a value read moments earlier, which collides
(`memory_versions_memory_id_version_no_key`) the second time the same memory
is revised. Both the SUPERSEDE and the new RESTATE branch now compute the
next version atomically (`UPDATE memories SET version = version + 1 ...
RETURNING version`) rather than trusting an earlier read. This was a real bug
independent of this feature — a decision revised twice in its lifetime would
have hit it before RESTATE ever existed — just one nothing in the existing
test suite had exercised until this work needed to revise the same memory
more than once.

## 5. Context Pack

`buildContextPack` (`src/services/context-pack-service.ts`) is a second,
separate function from `buildContextPackage` (`src/services/retrieval-service.ts`,
the query-driven "v2" shape shipped since damc_context in 1.0.0). They answer
different questions and neither replaces the other:

| | `buildContextPackage` (existing) | `buildContextPack` (new) |
|---|---|---|
| Question | "what matches this search text" | "what does DAMC currently know for this project" |
| Input | a required query string | an optional project id, nothing else required |
| Shape | flat `memories[]` + `relations[]` | `activeDecisions` / `activeTasks` / `constraints` / `importantMemories` / `recentContext`, each capped |
| Exposed as | `GET /v1/context`, MCP `damc_context` (both untouched) | `GET /v1/context/pack`, MCP `context_pack` (both new) |

Every bucket is capped (10 / 10 / 8 / 8 / 6) and `recentContext` explicitly
excludes a raw HISTORY dump — it is the newest handful of memories of any
type, never "every HISTORY entry", which is the one thing a Context Pack
exists to avoid becoming. `formatContextPackAsText` renders the pack as plain
text meant to be pasted into any AI's chat box; that plain format *is* the
"provider-specific shape" the pack converts into, because no provider has an
API to push formatted context into anyway (§2) — a copyable block is the one
thing that actually works for both.

## 6. Sync Center

The former Connections page is the product's front door (`web/pages/connections.js`,
route `#/connections`, labelled "Sync Center" / "동기화 센터"). It answers four
questions in the order a person actually asks them:

1. **Is it connected?** — per-provider state and a Connect / Disconnect button
   that hits the real endpoints from §3, plus an Import button that jumps to the
   Import page with that provider preselected.
2. **Is automatic import on?** — live watcher state and path, with Open folder /
   Manage import. The controls that start and stop watching stay on the Import
   page rather than being duplicated here; this card is status plus a way in.
3. **When did it last import?** — the six most recent `sync_jobs` rows, the same
   data the Sync page lists in full.
4. **How much is remembered?** — memories / decisions / tasks / projects /
   conversations, counted by `getDashboard` (the decision and task counters were
   added for this; the fields the Overview page already used are unchanged).

Capability rows on each provider card come straight from the capability model in
§2 — 지원 / 미지원 next to Import, Manual sync, Context export, Live auto sync and
Push into chat — so what the page claims and what the backend reports cannot
drift apart.

**No demo data on this page.** Every other page falls back to `demo-data.js`
when no backend answers, clearly banner-marked. The Sync Center does not: a
fabricated "1,284 memories" is indistinguishable from a real one at a glance, so
without a live backend the page says exactly that and links to Settings instead
of filling in numbers.

The longer capability/policy detail and the non-AI integrations (Obsidian,
GitHub) moved into a collapsed "전체 연동 및 정책" section at the bottom — nothing
was removed, it is just no longer the first thing on the screen.

## 7. What is explicitly NOT here

Consistent with §2 and with the product's own standing promise (Connections
page notice, present since the multi-AI connector work): none of the
following exist, and nothing in the UI, the API responses or this document
claims otherwise.

| Capability | Status |
|---|---|
| ChatGPT/Claude account OAuth | NOT_SUPPORTED — no such API for consumer chat history |
| Live/continuous account sync | NOT_SUPPORTED — same reason |
| Pushing a Context Pack into a ChatGPT/Claude thread | NOT_SUPPORTED — no such API |
| Gemini / local LLM / other providers | Not implemented this round — `connectProvider`/`disconnectProvider` reject anything outside `chatgpt`/`claude` with `NOT_SUPPORTED` rather than a silent no-op |

What *is* real and shipped: file import (three modes), Common Memory merge
and cross-provider supersession, per-provider connect/disconnect of the local
pipeline, and the Context Pack — usable right now by any MCP client (Claude
Code today; Cursor/Gemini/Grok/ChatGPT already READY per
`docs/DAMC_MULTI_AI_CONNECTOR.md`) or by hand via `GET /v1/context/pack`.

## 8. Tests

- `tests/connector-capabilities.test.ts` — pure unit, pins the capability
  table in §2 down so it cannot silently drift.
- `tests/common-memory.integration.test.ts` — isolated `damc_test` database
  (see `tests/import-pipeline.integration.test.ts`'s header for how that
  database is provisioned and why tests skip themselves rather than fail the
  suite when it is unreachable): restatement merge, dimension-mismatch
  non-merge, cross-provider supersede, connect/disconnect including the
  disconnect-safety row-count check, and the Context Pack (bucket caps,
  HISTORY exclusion, plain-text rendering).
- Existing suites (Korean classification, decision dimension, import
  pipeline, watch folder, CLI, MCP) are unchanged and still pass — this
  feature is additive on top of them, not a replacement.
