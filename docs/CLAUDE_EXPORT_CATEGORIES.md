# Claude export packages — what DAMC maps, and the evidence for it

Claude's **Export your data** no longer produces one `conversations.json`. It
produces a small manifest JSON that lists several category archives, each behind a
single-use download URL:

```json
{
  "instructions": "Download each file using the export_url. Note: Each export URL can only be used once.",
  "created_at": "2026-09-12T16:13:38.878192+00:00",
  "total_files": 5,
  "version": "1.0",
  "data_files": [
    { "category": "conversations",  "part": 0, "batch_index": 0, "filename": "conversations-000.zip",  "export_url": "https://claude.ai/…" },
    { "category": "projects",       "part": 0, "batch_index": 0, "filename": "projects-000.zip",       "export_url": "https://claude.ai/…" },
    { "category": "memories",       "part": 0, "batch_index": 0, "filename": "memories-000.zip",       "export_url": "https://claude.ai/…" },
    { "category": "design_chats",   "part": 0, "batch_index": 0, "filename": "design_chats-000.zip",   "export_url": "https://claude.ai/…" },
    { "category": "light_metadata", "part": 0, "batch_index": 0, "filename": "light_metadata-000.zip", "export_url": "https://claude.ai/…" }
  ]
}
```

Every field named above is one a real manifest contains — verified against the
manifest in `D:\APP\memory\manifest-…-2026-09-12-16-13-38.json` (version `1.0`,
5 files). No field in `claude-manifest-service.ts` was invented.

## The rule this document exists to enforce

> A field mapping is written against an observed structure. It is never inferred
> from a category name.

A memory written from a guessed mapping is indistinguishable from a correct one
once it is in the database, and DAMC's entire value is that its memories are
traceable to a real source. So a category DAMC has not opened does not get a
parser — it gets kept, listed, and left alone.

## Disposition per category

| Category | Disposition | Basis |
| --- | --- | --- |
| `conversations` | **Imported** | The archive carries `conversations.json` or numbered `conversations-NNN.json` shards — the same layout `parseClaudeConversation` already reads and the streaming importer already handles for a manually uploaded Claude ZIP. Selection is by `import-archive-service.selectConversationEntries`; nothing category-specific was added. |
| `memories` | Retained, not mapped | Structure not observed. See below. |
| `projects` | Retained, not mapped | Structure not observed. |
| `design_chats` | Retained, not mapped | Structure not observed. |
| `light_metadata` | Retained, not mapped | Structure not observed. |

The category in that table is a *hint*, not the decision. What actually routes an
archive is its own entry listing, read without decompressing anything: an archive
containing `conversations.json` (or its numbered shards) is imported whatever its
category is called, and one that does not is retained. So a `design_chats` package
that turns out to hold conversations is imported **on the evidence** — which is
reading a mapping, not inventing one — and a `conversations` package that turns out
not to is retained rather than failed.

"Retained, not mapped" means DAMC does two things and refuses a third:

1. **Keeps the archive.** An `export_url` works once. Downloading a category and
   discarding it because no parser exists yet would destroy data the user cannot
   get back. The archive is moved to `<DATA_DIR>/claude-export/<jobId>/`.
2. **Records the real structure.** The archive's entry names and header sizes are
   read without decompressing anything (`inspectArchiveEntries`) and written onto
   the sync job. That listing is the evidence a future mapping is written against.
3. **Does not create memories from it.** No rows, no candidates, no inferred
   fields.

Code: `src/services/claude-category-service.ts` (`IMPORTABLE_CATEGORIES`,
`CATEGORY_DISPOSITION`, `retainArchive`).

## Why the four structures were not observed

The archives could not be obtained. `claude.ai` answers a server-side client with
a Cloudflare bot-protection interstitial rather than the file. Verified directly
against the live endpoints in the manifest above:

| Probe | Result |
| --- | --- |
| `curl` default identity | `403`, `Cf-Mitigated: challenge`, `Server: cloudflare`, `Content-Type: text/html`, body `<!DOCTYPE html>…<title>Just a moment...</title>` |
| `curl -A "DAMC/1.2.0 (+self-hosted memory hub)"` | `200`, `Content-Type: text/html`, body still contains `challenge` |
| DAMC's own downloader, all 5 URLs | every one failed; zero redirects; hosts attempted: `claude.ai` |

The second row is the dangerous one: HTTP 200 with an HTML challenge page. A
downloader that trusted the status code would have written ~5 KB of HTML to disk
and reported a successful download. `claude-download-service.ts` therefore checks
two things beyond the status — the `cf-mitigated` header, and the first four bytes
of what actually arrived (`PK\x03\x04`) — and fails with
`DOWNLOAD_BLOCKED_BY_CHALLENGE` instead.

Getting past that interstitial would mean impersonating a browser or replaying
browser credentials. Both are out of scope by explicit project policy
(`CLAUDE.md`: no password storage, no browser cookie extraction, no CAPTCHA
bypass, no unofficial scraping), so DAMC reports the obstacle instead of working
around it.

## How an export is actually imported

Because the server cannot fetch these URLs, **the browser does** — which is what
Claude's own `instructions` field tells the user to do. That is the default path,
and it is the only one the dashboard offers:

1. The user drops the manifest onto the import box. The page recognises it, and
   **parses it locally**: every `export_url` stays in that browser tab. No download
   URL is sent to the server, stored in the database, or written to a log. What the
   server is told is the package list — category, filename, part — which is all it
   needs to recognise an arriving file and none of it secret.
2. The page opens a session (`sync_jobs.status = 'awaiting_download'`) with one row
   per package in `claude_export_packages`, ordered conversations-first.
3. One package at a time, the user clicks "download in your browser". The link
   opens in their own browser, so Claude's login and bot protection are handled by
   the browser exactly as they normally would be. DAMC records that the link was
   opened, and never offers it again once its file has arrived.
4. The downloads land in the watch folder (`C:\DAMC_IMPORT`). The watcher matches
   each file to its package by filename — absorbing the `conversations-000 (1).zip`
   rename every browser does — and routes it **by the archive's real entry
   listing**: conversation data goes through the existing streaming importer,
   anything else is retained with its structure recorded.
5. When every package is accounted for the session settles to
   completed / partial / failed and reports what the export added, per category.

The pieces in steps 4–5 are the ones DAMC already had: `import-upload-service`,
`import-archive-service`, `import-stream-service`, `import-progress-service` and
the watch folder, unchanged. What is new is the session that remembers which
one-time links are spent and which files have arrived.

### The server-side downloader is still there

`POST /v1/import/claude/manifest` still exists and is still SSRF-constrained,
streaming and tested — it is correct for any host that actually serves the file. It
is not the default, and a blocked attempt no longer reports a failed import: the
job parks at `awaiting_download` with every link untouched, so the browser path
above is still available. That is the whole reason the challenge branch refuses to
mark the job failed.

## How to add a category later

1. Obtain a real archive of that category (a browser download is fine).
2. Read its structure — `inspectArchiveEntries` prints the entry names; a retained
   archive from a past job already has its listing recorded on the sync job.
3. Write the parser against what is actually in it, with the observed shape quoted
   in the parser's own comment the way `claude-manifest-service.ts` quotes the
   manifest.
4. Add the category to `IMPORTABLE_CATEGORIES` and update the table above with the
   basis.

Steps 1–3 before step 4, in that order. That ordering is the whole point.
