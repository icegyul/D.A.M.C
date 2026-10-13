# DAMC v0.4 Release

## Goal
Turn the v0.3 backend foundation into a usable single-user DAMC application with a built-in UI and file-based provider ingestion.

## Acceptance
- `GET /health` reports v0.4.0.
- Dashboard exposes memory/project/relation counts.
- ChatGPT/Claude JSON and ZIP export files can be uploaded to `/v1/import/:provider/file`.
- Import is idempotent through existing conversation/content hashes.
- Current State and Graph are visible in the web UI.
- API-key/Bearer authentication remains available; dev mode is only for local use.
- No consumer account password/cookie scraping is present.
