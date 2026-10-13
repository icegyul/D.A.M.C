# DAMC Import Automation

## 1. What this adds

Manual file upload was the only way conversations reached DAMC. This adds two
more entry points — a CLI command and a watched local folder — without adding
a second pipeline. All three modes call the exact same functions:

```
provider parser -> normalize -> conversation dedupe -> source registration
   -> message ingestion -> classifyMessage -> extractCandidates
   -> memory creation -> DECISION/TASK handling -> supersedes -> provenance
```

`runImportJob` (`src/services/sync-service.ts`) is the one entry point into
that pipeline. Web upload, the CLI and the watch folder all call it; none of
them parses, deduplicates or classifies anything themselves.

## 2. The three modes

| Mode | Entry point | Provider |
|---|---|---|
| Web upload | Import page, drag & drop or file picker | chosen in the UI |
| CLI | `npm run damc:import -- <chatgpt\|claude> "<path>"` | given on the command line |
| Watch folder | drop a file into `D:\DAMC_IMPORT` | auto-detected from the file's shape |

### `damc import ...` and `npm run damc:import -- ...`

Both work, and they are the same code path:

```powershell
.\damc import chatgpt "C:\path\to\conversations.json"     # wrapper, easiest to remember
npm run damc:import -- chatgpt "C:\path\to\conversations.json"   # what it actually runs
npm run import:export -- chatgpt "C:\path\to\conversations.json" # original v0.1 name, still works
```

`damc.cmd` in the project root is a ~20-line shim that forwards to the npm
script — it is not a second implementation, and it deliberately is not
installed onto PATH: DAMC is a Node/TypeScript project run with `tsx`/`npm`,
not a globally installed binary, and publishing a global `damc` executable
would mean shipping a separate distribution artifact just for an alias. Run it
from the project folder.

All argument parsing, output formatting and orchestration live in
`src/cli/import-cli.ts` as plain functions (`parseArgs`, `formatResult`,
`runCli`) that take their dependencies as parameters — `damc.cmd`, the npm
script and `scripts/import-export.ts` all end up there.

`scripts/import-export.ts` only supplies the real dependencies
(`fs.readFile`, `runImportJob`, `pool.end`). That split is what makes
`tests/import-cli.test.ts` able to exercise the whole CLI flow without
spawning a process or touching a database.

### Watch folder

Default location: `C:\DAMC_IMPORT`, configurable via `DAMC_IMPORT_WATCH_DIR`.
`processed\` and `failed\` are created under it automatically the first time
watching starts. C: rather than D: on purpose — not every Windows machine has
a D: drive, and the root of C: does not need elevation (`C:\Program Files`
does; verified directly rather than assumed — see the commit that changed
this). Off by default in the source tree/dev compose — nothing watches the
filesystem until an operator presses **Start watching** on the Import page, or
sets `DAMC_IMPORT_WATCH_AUTOSTART=true` for every boot. The release payload
(what an installed, distributed copy runs) sets that flag to `true`, so a
freshly installed DAMC is already watching before anyone opens the dashboard.

**It stays on across restarts.** The watcher itself is an interval inside the
app process, so on its own it would die with the container and never come
back. Switching it on therefore also persists the choice
(`src/services/watch-state-service.ts`, stored in the existing `connectors`
table under a reserved key — no migration), and the server checks that on boot
(`src/server.ts`) to decide whether to resume. That is what makes "자동 감시 중"
still true after `docker compose restart`, a Docker Desktop restart or a
Windows reboot. Switching it off persists too, so it does not come back
uninvited. Verified live: restart the app container with the watcher on and
the log line reads `import watch folder started` with `reason: "persisted"`.

**Docker note:** DAMC runs inside a container, so it cannot see
`C:\DAMC_IMPORT` unless it is bind-mounted in. `docker-compose.yml` mounts
`C:/DAMC_IMPORT` (host) to `/damc-import` (container) and sets
`DAMC_IMPORT_WATCH_DIR=/damc-import` — the path Node actually reads/writes —
plus `DAMC_IMPORT_WATCH_HOST_DIR=C:\DAMC_IMPORT`, which is cosmetic only: the
real Windows path shown in the UI and used for the "Open folder" link. Running
the server directly on Windows (`npm run dev`, no Docker) needs neither
override; there is only one path in that case.

**File-copy safety.** A file mid-copy must never be read. Every scan checks a
candidate file's size and mtime, waits ~700ms, and checks again — only a file
that reports the same of both twice is considered stable. An unstable file is
left in place and picked up on a later scan; it is never partially imported.

**Provider detection.** Nobody is present to choose a provider for a watched
file, so `detectProvider` (`src/connectors/provider-export-parsers.ts`) looks
at the export's own shape: a ChatGPT conversation carries a `mapping` node
graph, a Claude conversation carries a `chat_messages` array. If neither shape
is recognized, the file moves to `failed\` as `UNSUPPORTED_PROVIDER` rather
than being guessed at and run through the wrong parser.

**No duplicate imports from re-detection.** A file is moved out of the watched
folder (to `processed\` or `failed\`) as its very last step, and an in-memory
set tracks the filename while it is being handled — a second scan mid-import
is a no-op. On top of that, the pipeline's own dedup (provider + external id,
per-message content hash) means even a manually re-copied file imports
nothing new the second time.

## 3. Provider selection (web + CLI)

Explicit, same as before: a provider selector in the UI, a required CLI
argument. Auto-detection exists only for the watch folder, where nobody can be
asked — see above.

## 4. Job tracking

Reuses `sync_jobs` (present since v0.1), no migration needed — `stats` is
`jsonb`, so `source` (`web`/`cli`/`watch`), `fileName`, `decisionCount`,
`taskCount` and any per-conversation `errors` all fit in the existing column.
Status is now one of `queued`, `completed`, **`partial`** or `failed`:

- **completed** — every conversation in the batch imported (or deduplicated) cleanly.
- **partial** — at least one conversation failed but at least one succeeded.
  The batch's successful conversations are kept; nothing already written is
  rolled back to manufacture an all-or-nothing result.
- **failed** — nothing in the batch could be imported.

The Import page shows the six most recent jobs inline (reusing the same
`GET /v1/sync/jobs` the Sync page already used); the Sync page remains the
full history.

## 5. Error handling

| Situation | Where it shows | Code |
|---|---|---|
| File is not JSON or a ZIP with `conversations.json` | watch folder → `failed\`, CLI → exit 1 | `INVALID_JSON` |
| Well-formed but neither ChatGPT nor Claude shape | watch folder → `failed\` | `UNSUPPORTED_PROVIDER` |
| JSON parses but the provider parser rejects it | watch folder → `failed\`, CLI → exit 1 | `PARSE_ERROR` |
| `runImportJob` itself throws (e.g. database unreachable) | watch folder → `failed\`, CLI → exit 1 | `IMPORT_ERROR` |
| File never stabilizes | left in place, retried on the next scan | `FILE_UNSTABLE` |

## 6. Security

- Everything stays local: no new externally-reachable endpoint. The watch
  status/start/stop routes sit under the same `/v1` prefix and the same
  dev-mode/API-key authentication as every other route.
- The watch folder never deletes a source file. A processed or failed file is
  *moved* into `processed\`/`failed\`, never removed.
- The CLI's report (`DAMC IMPORT` / `RESULT` block) prints only counts, file
  names and provider — never message content, so a redirected log or a
  terminal scrollback never ends up holding a conversation's text.
- No new credentials of any kind are introduced by this feature.

## 7. Tests

`tests/import-cli.test.ts`, `tests/import-watch.test.ts` and the
`detectProvider` cases in `tests/provider-export.test.ts` are pure unit tests
(no database). `tests/import-pipeline.integration.test.ts` is the one file in
the suite that talks to Postgres — against an isolated `damc_test` database,
never the `damc` database the dev/production stack uses. See that file's
header comment for how to provision it and why it skips itself rather than
failing the suite when that database is not reachable.
