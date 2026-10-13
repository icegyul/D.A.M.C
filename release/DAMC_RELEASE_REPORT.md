# DAMC 1.0.0 — Release Report (historical)

> **This document describes the 1.0.0 release and has not been rewritten since.**
> Its installer size, SHA256, image tag and endpoint counts are 1.0.0 values, not
> the current build's. For the state of this directory see `RELEASE_STATUS.md`.

Everything below was executed and observed. Items that were not verified are
marked NOT_VERIFIED rather than assumed.

| | |
|---|---|
| Project root | `D:\APP\DAMC_app` |
| Version | 1.0.0 (was 0.4.0) |
| Installer | `release\DAMC_Setup.exe`, 180,827,537 bytes |
| SHA256 | `3CE31A0E97A79421A63E6A9AA2C30819A6BB2BD843D2AEF4890798306B2C6FBE` |
| Docker image | `dalur/damc:release-1.0.0` (289 MB) |
| Bundled images | `dalur/damc:release-1.0.0` + `postgres:17-alpine`, 174 MB tar |

## Code closed in this release

Two defects blocked a usable first install and were fixed here.

**Migrations could never run in a container.** `dist/scripts/migrate.js`
resolved `../migrations`, which is `/app/dist/migrations` in the built image
while the SQL actually lives at `/app/migrations`. A fresh installation could
never create its schema. Resolution now tries both layouts.

**A fresh database had no user, so every write failed.** Dev mode resolves
requests to a fixed user id; on a new database that row does not exist and every
table keys on `users(id)`, so the first write failed the foreign key and
`/v1/state` returned 500. The row is now provisioned once at startup. The
installer's start script was also reordered to migrate *before* the application
boots, because the provisioning step needs the tables to exist.

**Detection gap.** Explicit change declarations (변경했다 / 바꿨다 / 교체했다 /
전환했다 / 수정했다, and their 하기로 했다 forms) now register as decisions.
Possibility, requirement and intent are excluded, so "변경할 수 있다",
"변경이 필요하다" and "변경될 예정이다" still settle nothing.

## Verification

| Check | Result |
|---|---|
| Tests | 182 / 182 pass |
| Build | `npm run build` exit 0 |
| Secret scan | no hits |
| Docker build + run | app and db healthy |
| DB pool resilience | `restart db` — same PID, restart count 0, no crash trace |
| Restart policy | db and app both `unless-stopped` |
| Port binding | 8787 and 5432 on `127.0.0.1` only, LAN unreachable |
| Frontend | 8 routes, 0 JS errors, 0 error blocks, 0 stuck spinners |
| API | 8 / 8 `/v1` endpoints 200 |
| Production data | 15 memories / 2 projects / 18 relations / 6 conversations, unchanged |
| Installer build | ISCC exit 0 |
| Install | exit 0; files, 6 shortcuts, log dir and uninstall entry all present |
| First start | bundled images loaded, schema migrated, health 200 |
| Fresh install API | 8 / 8 endpoints 200, local user auto-provisioned |
| Smoke test | decision detection, supersession, dimension isolation, duplicate skip, TASK stays candidate |
| Uninstall | silent, exit 0; app, shortcuts, containers and registry entry removed |
| Data safety | data volume kept by default on uninstall |
| Reinstall | exit 0; all 4 memories, statuses and the SUPERSEDES relation restored |

### Smoke test detail, run against the installed product

```
배포 방식은 Docker로 결정했다.            -> DECISION active
배포 방식은 Kubernetes로 변경했다.        -> SUPERSEDES it; old superseded, relation stored
배포 일정은 9월 20일로 결정했다.          -> independent (schedule, not method)
배포 방식은 Kubernetes로 변경했다. (again) -> duplicate skipped, 0 created
다음 작업은 백업 스크립트를 추가하는 거야.  -> TASK, stays candidate
```

## Secret scan

Scanned `src`, `web`, `migrations`, `scripts`, `docs`, `package.json`,
`package-lock.json`, `docker-compose.yml`, `Dockerfile`, `README.md`,
`CLAUDE.md`, `tsconfig.json`, `.env.example`.

Patterns: `sk_live_`, `sk_test_`, `service_role`, `AKIA…`, AWS secrets, private
key headers, JWT (`eyJhbGciOi`), Slack tokens, GitHub tokens (`ghp_`,
`github_pat_`), `password=`, `SUPABASE_SERVICE`, `JWT_SECRET=`.

**Result: zero hits.** `.env` is gitignored and untracked; no `.pem`, `.key`,
secret or credential file is tracked.

The only credential-shaped string is `postgresql://damc:damc@…`, the local
container's own PostgreSQL password. It is documented in `.env.example` by
design and reachable only on loopback. It is not an external secret, but it is
also not a strong password — change it before running DAMC anywhere other than
a single-user local machine.

## Known limitations

- Semantic embeddings are an abstraction only.
- Memory extraction is heuristic; candidates are never silently promoted.
- No multi-user authentication. DAMC is local and single-user.
- Obsidian export is one-way; GitHub backup needs host git credentials.
- Live provider account sync does not exist and is never shown as connected.
- A bare topic with no dimension ("배포는 Docker로 결정했다") links to any
  qualified form of that topic, since "배포" and "배포 방식" are treated as the
  same subject.

## Not verified

- **Clean-machine install.** Everything was tested on the development machine,
  which already had Docker Desktop and both images. The bundled-image load path
  was exercised by deleting the local image tag first, but a Windows machine
  with no Docker Desktop at all was not tested.
- **The Docker-missing installer branch.** Docker Desktop is installed here, so
  the prerequisite warning and the disabled post-install step were not observed
  running.
- **Windows reboot persistence.** Restart policies and Docker Desktop autostart
  were both confirmed by inspection, but no reboot was performed.
- **Interactive (non-silent) installer wizard.** Install, uninstall and
  reinstall were all driven with `/VERYSILENT`.
