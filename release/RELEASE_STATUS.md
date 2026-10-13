# Release status — 1.2.0

State of this directory as of the 2026-09-13 finalization pass. Every number below
was read off the artifact or the running product on that date; none is carried over
from an earlier build. The installer was recompiled during this pass, so the size and
hash differ from the ones this file previously recorded.

## Artifacts

| Artifact | State |
|---|---|
| `DAMC_Setup.exe` | **CURRENT.** Compiled 2026-09-13 19:52 by `scripts\package-release.cmd` (Inno Setup 6). 206,744,339 bytes, SHA256 `04AE6F9ABF10729E362B20924E8E1EFBE5A18C5284ACC5B71BDFE93148C4EFC7`. |
| `DAMC_SHA256.txt` | **CURRENT.** Regenerated for the installer above; declared size and hash both match the file byte for byte. |
| `payload/images/damc-images.tar` | **CURRENT.** 207,919,104 bytes, SHA256 `b289fe68d09dd56834d1b7d64c43548f9184ae05b779dfd45e6c4fb1706c8565`. Carries `dalur/damc:release-1.2.0` + `postgres:17-alpine`, migrations 001–007, and a `dist/` whose only script is `dist/scripts/migrate.js` — the demo seeder is no longer compiled into the image. |
| `payload/docker-compose.yml` | **CURRENT.** Runs with `DAMC_DEV_MODE: "false"`. Publishes only the app, on loopback; PostgreSQL is not published to the host at all. Mounts `damc_storage` at `/app/storage`. |
| `payload/scripts/damc-start.cmd` | **CURRENT.** `docker load` now runs on every start instead of being skipped when a same-named tag exists — that skip made an upgrade over an existing 1.2.0 install a silent no-op. |
| `payload/scripts/damc-uninstall-cleanup.cmd` | **CURRENT.** `purge` removes both `damc_damc_pg` and `damc_damc_storage`; without it, neither. |
| `payload/README.txt` | Current. |
| `installer/DAMC.iss` | Current. `AppVersion` 1.2.0, matching `package.json` and `src/version.ts`. |
| `DAMC_RELEASE_REPORT.md` | Historical — documents the 1.0.0 release. Its size, SHA256 and endpoint counts are 1.0.0 values. Kept for provenance; do not read it as current. |

## What changed in this pass, and why

Five things about the *shipped* product were wrong in a way no test could catch,
because nothing in the suite read the release configuration or the shipped image.

1. **The developer's own project names were compiled into the import path.**
   `detectProjectHint` matched a hardcoded list against every imported conversation
   and created a `projects` row on a hit. Any user importing text that mentioned one
   of them got a project named after a stranger's work. Now `DAMC_PROJECT_HINTS`,
   defaulting to DAMC's own name only.
2. **The demo seeder shipped inside the production image.** `tsconfig.json` compiled
   all of `scripts/`, so `dist/scripts/seed.js` — which inserts a project and a
   conversation — rode along next to the `dist/scripts/migrate.js` that
   `damc-start.cmd` already runs against the user's live volume. Seeder deleted;
   `dist` now carries only the migrate entry point.
3. **The product ran in dev mode.** Now `DAMC_DEV_MODE: "false"`, which was only
   shippable once a first-run bootstrap existed — see below.
4. **PostgreSQL was published on `127.0.0.1:5432` with the password printed in the
   same file.** Any local process could read the entire memory database directly,
   which made the API's own authentication decorative. The port is closed; the
   operator path is `docker compose exec db psql -U damc -d damc`.
5. **Upgrade was a silent no-op.** See `damc-start.cmd` above.

### Authentication, as shipped

`DAMC_DEV_MODE=false` means every `/v1` request needs an API key. The one exception
is `POST /v1/auth/bootstrap`: a request that **originates on this machine** may claim
a key without presenting one, and the bundled dashboard does exactly that on first
open, so "install it and open it" still works with no terminal. Forwarding headers
disqualify a request, so a proxy or tunnel can never reach it.

It is deliberately *not* also gated on "no key exists yet". That gate was tried and
removed: it locked the owner out permanently once they cleared their browser storage
(keys are hashed — nothing to recover), while stopping nothing a hostile local
process could not do by reading the stored key off disk. What replaces it is
attribution: every such key is labelled `local-dashboard`, listed on the Connections
page, and revocable. Compared with the dev mode it supersedes, the same callers can
get in, but they can no longer act anonymously and cannot claim an arbitrary
identity through `X-DAMC-User-Id`.

## Verified on a clean machine

The machine was reduced to a genuine first-install state before this pass: the
previous install uninstalled, `damc_damc_pg` and `damc_damc_storage` removed, and the
`dalur/damc:release-1.2.0` image deleted so the installer's `docker load` path was
exercised for real. The developer's own stack (project `damc_app`, volumes
`damc_app_damc_*`) was never touched, and its row counts were identical before and
after: 237 conversations, 5,299 messages, 4,056 memories, 6 projects.

| Check | Result |
|---|---|
| Silent install | exit 0, 34 s; DAMC auto-started from the post-install task |
| `/health` | `devMode: false`, `auth: {required: true, bootstrapped: false}`, no secret in the payload |
| Migrations | 001–007 all applied |
| User data on a fresh install | conversations, messages, memories, memory_versions, relations, projects, sync_jobs, current_states, api_keys, claude_export_packages — **all 0**. `users` = 1 (the local owner row every foreign key needs; no content) |
| `pg_trgm` + Korean trigram indexes | extension present, 3 indexes |
| Database reachable from the host | **no** — `connection refused` on 127.0.0.1:5432 |
| Dashboard, first open in a fresh browser | claimed its own key, chip "연결됨", zero UNAUTHORIZED, all counters 0, honest empty states with import guidance, no demo/sample wording anywhere |
| Test suite | 746 tests in 39 files, all passing, run with `DAMC_REQUIRE_DB=1` so the five database-backed files cannot silently skip. No test was deleted, skipped or weakened; the three integration files that shrank did so because their duplicated migration bootstrap moved to `tests/helpers/database.ts`, which also added the `DAMC_REQUIRE_DB` hard failure |
| MCP | 22 tools on `/v1/mcp` and on the authenticated `/mcp` gateway; 401 for a missing and for a wrong key |
| ChatGPT 1.91 GB export (3-shard ZIP) | preview 9.9 s, wrote nothing; full import 51 s → 236 conversations, 5,296 messages, 4,053 memories, 968 decisions, 1,050 tasks, 0 errors |
| Re-import of the same export | 236 detected, 0 imported, 236 deduplicated, 0 new memories |
| Claude manifest (the real one) | detected, version 1.0, 5 categories, `urlsConsumed: false`, no URL in the response or the logs; session created from the plan with no URL sent |
| Claude packages via the watch folder | 5/5 settled — `conversations` imported, `projects` / `memories` / `design_chats` / `light_metadata` retained with their real entry listings. See the disclosure below: the archives fed to the watch folder were labelled stand-ins, not the real Claude downloads |
| Hermes (v0.21.2) as an MCP client | registered per its own config format, token in Hermes' `.env` as `MCP_DAMC_API_KEY` and only `Bearer ${MCP_DAMC_API_KEY}` in `config.yaml`; `hermes mcp test damc` connected in 953 ms and listed 22 tools; an ordinary agent turn provably called `memory_search`, `active_decisions` and `task_search` (DAMC's own activity feed, 11:06:07) |
| MCP write round trip | Hermes `decision_create` → `b88ba716-5fa1-41ee-b510-8000f2be5715` (activity 11:07:12); confirmed in the database and over the REST API; then re-read **from Hermes** with all five fields identical (`memory_get`, activity 11:11:16) |
| Security | non-allowlisted/`http` download URL refused with `DOWNLOAD_URL_REJECTED` before any connection; malformed archive 400; malformed JSON 400; manifest on the generic import route 409; no `Access-Control-Allow-Origin` for a foreign Origin; spoofed `X-DAMC-User-Id` 401 |
| Upgrade (1.2.0 over 1.2.0) | exit 0, 35 s; container moved to a **different** image id; 238 conversations / 4,055 memories / 5,299 messages / 1 api_key all preserved; 7 migrations; the pre-upgrade key still worked |
| Restart | stop + start; data intact, watcher resumed, no job left in `running`/`queued`, the Claude session's packages still `imported`/`retained` |
| Uninstall (default and silent) | exit 0; install directory removed; `damc_damc_pg` and `damc_damc_storage` **kept** (416.8 MB of PostgreSQL data still in the volume) |

### What the verified install now contains, and what is not real

The installed database was left as the verification found it rather than cleaned out,
because deleting rows from an install that also holds a real 1.91 GB import is not a
call to make silently. Three rows in it are **not** user data, and every one of them
says so in its own title:

| Row | What it is |
|---|---|
| conversation `d7337473-668f-4d14-98ca-e9e7759e824d` — `[VERIFICATION ARTIFACT] DAMC 1.2.0 Claude package import` (2 messages) | The Claude `conversations` package was a labelled stand-in archive. The real `export_url`s are single-use and sit behind Cloudflare bot protection, so the genuine download could not be obtained here, and spending the one-time URLs was not something to do unasked. What this proves is the pipeline — manifest → session → watch folder → route by entry listing → import — not the content. |
| memories `fc787510-…` (DECISION, active) and `da866d69-…` (TASK, candidate) | Extracted from that stand-in conversation's two messages. Both titles begin `[VERIFICATION ARTIFACT]`. |
| memory `b88ba716-5fa1-41ee-b510-8000f2be5715` (DECISION, active) | The MCP write round trip above. |

So the installed totals — 237 conversations, 5,298 messages, 4,056 memories — are
236 / 5,296 / 4,053 of real imported ChatGPT data plus exactly those four rows.
Removing them, if you would rather start clean, is four deletes:

```
docker compose exec db psql -U damc -d damc -c "delete from memories where id in ('b88ba716-5fa1-41ee-b510-8000f2be5715','fc787510-a623-4f11-bf12-05b41ae82da8','da866d69-72b3-44ca-953b-99f1e190089f'); delete from conversations where id='d7337473-668f-4d14-98ca-e9e7759e824d';"
```

Worth doing before real use: retrieval does not know these three memories are props.

## Known limitations

- **The Claude export path has never run on a real Claude archive.** Manifest parsing,
  the session model and the URL refusal are all exercised against the real
  `manifest-*.json`; the archives themselves are not. See the disclosure above.
- **`docker load` on a machine that has never held the image** is now exercised —
  this pass deleted the tag first, which earlier passes could not claim.
- **The PostgreSQL password is a fixed `damc`.** With the port no longer published
  this is reachable only from inside the compose network, but it is still a constant
  rather than a generated secret.
- **A single trust boundary remains the machine itself.** Any process running as the
  user can claim an API key (it can also read the dashboard's stored one). DAMC is a
  local single-user store and does not defend against a compromised account.
- **Remote Access** publishes the MCP gateway through a tunnel; that path always
  required a key and still does, whatever the local posture.
