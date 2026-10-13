-- DAMC v0.6: Claude export packages, delivered by the user's own browser.
--
-- WHY THIS TABLE EXISTS. claude.ai answers a server-side download with a
-- Cloudflare bot-protection page, and DAMC will not pretend to be a browser to
-- get past it. So the user's own browser does the download — which is exactly
-- what Claude's manifest tells them to do — and the files arrive in the watch
-- folder. That turns one HTTP request into a session that waits on a human:
-- minutes or hours, across page reloads and container restarts. None of that can
-- live in memory.
--
-- WHAT IS NOT HERE: the export_url. In this flow it never reaches the server at
-- all. The dashboard parses the manifest locally and keeps the URLs in browser
-- memory only, so a bearer credential that grants one download of the user's
-- entire history is never written to a database that gets backed up to GitHub.
-- Only the parts that are not secret are stored: category, filename, part.
--
-- IDENTITY. A package is identified by (session, filename). filename is what the
-- browser will write to disk, so it is the only thing an arriving file can be
-- matched on; `part` disambiguates within a category. Two exports both contain
-- conversations-000.zip, so matching an arriving file has to be scoped to one
-- session — which is why starting a session supersedes the previous one's
-- unfinished packages rather than leaving both waiting for the same name.
CREATE TABLE IF NOT EXISTS claude_export_packages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The session job. Its sync_jobs.status is 'awaiting_download' while any
  -- package is still pending, which deliberately keeps it out of the
  -- 'running'/'queued' set that boot reconciliation fails.
  session_job_id uuid NOT NULL REFERENCES sync_jobs(id) ON DELETE CASCADE,
  -- 1-based display position, so the UI can say "[2/5]" without re-deriving it.
  sequence int NOT NULL,
  category text NOT NULL,
  filename text NOT NULL,
  part int,
  -- What DAMC intends to do with this category: 'import' or 'retain'. Advisory
  -- only — the archive's real entry listing decides, not the category name.
  disposition text NOT NULL,
  -- awaiting_download -> opened -> detected -> importing -> imported | retained
  --                                                      -> failed
  -- plus 'superseded' for a package a newer session replaced.
  status text NOT NULL DEFAULT 'awaiting_download',
  bytes bigint,
  -- The observed structure: entry count and names, read without decompressing.
  -- This is the evidence a future parser for a retained category gets written
  -- against, and the cross-check that stops a filename from deciding a category.
  entry_count int,
  entry_names jsonb,
  -- The import job this package's conversations were ingested under, when it had
  -- any. Links a package to the ordinary sync_jobs history.
  import_job_id uuid REFERENCES sync_jobs(id) ON DELETE SET NULL,
  stats jsonb,
  error_code text,
  error_message text,
  -- When the user opened the download URL in their browser. Set once: a URL that
  -- produced a file must never be offered again.
  opened_at timestamptz,
  detected_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_job_id, filename)
);

-- Matching an arriving file: one indexed lookup by name among the packages still
-- waiting for one.
CREATE INDEX IF NOT EXISTS idx_claude_export_packages_pending
  ON claude_export_packages(user_id, filename, status);
CREATE INDEX IF NOT EXISTS idx_claude_export_packages_session
  ON claude_export_packages(session_job_id, sequence);
