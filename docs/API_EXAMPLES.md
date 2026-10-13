# API Examples

## Ingest normalized conversation

```bash
curl -X POST http://localhost:8787/v1/ingest/conversations \
  -H 'content-type: application/json' \
  -H 'x-damc-user-id: 00000000-0000-0000-0000-000000000001' \
  -d '{
    "provider":"chatgpt",
    "externalId":"demo-001",
    "title":"Nav redesign decision",
    "projectHint":"My Project",
    "messages":[
      {"role":"user","sequenceNo":0,"content":"내비게이션 메뉴를 단순화하기로 결정했다."},
      {"role":"assistant","sequenceNo":1,"content":"이 결정은 active 상태로 관리한다."}
    ]
  }'
```

## Search

```bash
curl 'http://localhost:8787/v1/memories?q=%EB%A9%94%EB%89%B4' \
  -H 'x-damc-user-id: 00000000-0000-0000-0000-000000000001'
```

## Context package

```bash
curl 'http://localhost:8787/v1/context?q=%EB%A9%94%EB%89%B4%20decision' \
  -H 'x-damc-user-id: 00000000-0000-0000-0000-000000000001'
```

## Obsidian export

```bash
curl -X POST http://localhost:8787/v1/export/obsidian \
  -H 'x-damc-user-id: 00000000-0000-0000-0000-000000000001'
```

## Memory status

```bash
curl -X PATCH http://localhost:8787/v1/memories/<MEMORY_ID>/status \\
  -H 'content-type: application/json' \\
  -H 'x-damc-user-id: 00000000-0000-0000-0000-000000000001' \\
  -d '{"status":"confirmed","reason":"Reviewed by user"}'
```

## Sync jobs

```bash
curl http://localhost:8787/v1/sync/jobs \\
  -H 'x-damc-user-id: 00000000-0000-0000-0000-000000000001'
```

## Memory list with filters and provenance

`GET /v1/memories` now joins the project, source and conversation records, so each
row carries `projectName`, `provider`, `sourceTitle`, `sourceExternalId`,
`conversationId` and `conversationTitle` alongside the original fields.
`importance` and `confidence` are returned as JSON numbers (0..1) rather than
PostgreSQL numeric strings.

```bash
curl 'http://localhost:8787/v1/memories?status=active&provider=chatgpt&minImportance=0.75&sort=newest&limit=50' \
  -H 'x-damc-user-id: 00000000-0000-0000-0000-000000000001'
```

Query parameters: `q`, `projectId`, `type`, `status`, `provider`, `minImportance`,
`sort` (`newest` | `relevance` | `importance`), `limit`.

## Memory detail

```bash
curl 'http://localhost:8787/v1/memories/<uuid>' \
  -H 'x-damc-user-id: 00000000-0000-0000-0000-000000000001'
```

Returns the memory with provenance, `versions[]`, `relations.outgoing[]`,
`relations.incoming[]` and the originating `sourceMessage`.

## Providers facet

```bash
curl 'http://localhost:8787/v1/memories/providers' \
  -H 'x-damc-user-id: 00000000-0000-0000-0000-000000000001'
```

## Import preview (parse only, writes nothing)

```bash
curl -X POST http://localhost:8787/v1/import/chatgpt/preview \
  -H 'x-damc-user-id: 00000000-0000-0000-0000-000000000001' \
  -F 'file=@conversations.json'
```

```json
{"provider":"chatgpt","fileName":"conversations.json","fileBytes":4459,
 "conversations":3,"messages":7,"sampleTitles":["…"],"dryRun":true}
```

## Import (JSON or ZIP)

```bash
curl -X POST http://localhost:8787/v1/import/chatgpt/file \
  -H 'x-damc-user-id: 00000000-0000-0000-0000-000000000001' \
  -F 'file=@chatgpt-export.zip'
```

## Claude export packages (manifest)

Claude's export is a manifest JSON listing category ZIPs behind single-use URLs.
Previewing reads the manifest only — no link is spent.

```bash
curl -X POST http://localhost:8787/v1/import/claude/manifest/preview \
  -H 'x-damc-user-id: 00000000-0000-0000-0000-000000000001' \
  -F 'file=@manifest.json'
```

```json
{"provider":"claude","mode":"manifest","version":"1.0","totalFiles":5,
 "categories":[{"category":"conversations","filename":"conversations-000.zip",
                "supported":true,"disposition":"import","alreadyUsed":false}],
 "urlsConsumed":false}
```

### Browser-download session (the default path)

`claude.ai` refuses a server-side download, so the packages are fetched by the
user's own browser and picked up from the watch folder. The session body carries
**no download URLs** — the dashboard keeps those in the browser tab, and this
endpoint refuses a body containing one.

```bash
curl -X POST http://localhost:8787/v1/import/claude/manifest/session \
  -H 'x-damc-user-id: 00000000-0000-0000-0000-000000000001' \
  -H 'content-type: application/json' \
  -d '{"version":"1.0","files":[
        {"category":"conversations","filename":"conversations-000.zip","part":0},
        {"category":"memories","filename":"memories-000.zip","part":0}]}'
```

```json
{"session":{"jobId":"…","status":"awaiting_download","totalFiles":2,
            "packages":[{"sequence":1,"category":"conversations",
                         "filename":"conversations-000.zip","disposition":"import",
                         "status":"awaiting_download"}]},
 "watcher":{"running":true,"hostDir":"C:\\DAMC_IMPORT"}}
```

`GET /v1/import/claude/manifest/session` returns the current session and the watch
folder state. `POST /v1/import/claude/manifest/session/:jobId/packages/:packageId/open`
records that the user opened one link — it is refused with `409` once that
package's file has arrived, which is where the "a one-time link is never offered
twice" rule is enforced.

Packages then arrive in the watch folder and are imported or retained by the
existing pipeline; the session settles to `completed` / `partial` / `failed` on its
own and reports what the export added per category.

### Server-side download (not the default)

Importing fetches the packages server-side and returns a job to follow. It answers
`202` immediately rather than holding the request open for several gigabytes. A
bot-protection block parks the job at `awaiting_download` with every link unused
rather than reporting a failed import.

```bash
curl -X POST http://localhost:8787/v1/import/claude/manifest \
  -H 'x-damc-user-id: 00000000-0000-0000-0000-000000000001' \
  -F 'file=@manifest.json'
```

```json
{"jobId":"…","provider":"claude","mode":"manifest","status":"queued","totalFiles":5}
```

Progress and the per-package outcome come from `GET /v1/import/progress/:jobId`
while it runs and from `GET /v1/sync/jobs` afterwards (`stats.files[]`). Uploading
a manifest to the ordinary `POST /v1/import/:provider/file` is refused with
`409 MANIFEST_DETECTED`: importing it spends single-use links, so it has to be an
explicit choice. See `docs/CLAUDE_EXPORT_CATEGORIES.md` for which categories are
parsed and why the others are only retained.

## Connector status

`GET /v1/connectors/capabilities` keeps its original `chatgpt` / `claude` /
`note` fields and adds a `providers[]` array covering ChatGPT, Claude, Obsidian
and GitHub. Each provider lists channels with an honest state:
`available`, `needs_configuration` or `not_available`. Account-history sync is
always reported as `not_available`.

## Status change

Note the verb: the backend uses `PATCH`, not `POST`.

```bash
curl -X PATCH http://localhost:8787/v1/memories/<uuid>/status \
  -H 'content-type: application/json' \
  -H 'x-damc-user-id: 00000000-0000-0000-0000-000000000001' \
  -d '{"status":"confirmed","reason":"reviewed"}'
```

## Authentication

`/health` and the bundled dashboard assets are public. Everything under `/v1` is
authenticated: `Authorization: Bearer <api key>`, or `X-DAMC-User-Id` when the
backend runs with `DAMC_DEV_MODE` enabled.
