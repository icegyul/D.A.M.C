-- DAMC v0.6: single-use Claude export download ledger.
--
-- A Claude export manifest hands DAMC a set of URLs that each work exactly once.
-- Two things follow from that, and both need durable state rather than in-process
-- memory:
--
--   A re-submitted manifest must not re-fetch a URL that was already spent. The
--   second fetch cannot succeed, and reporting it as a download failure would be
--   a lie about what happened.
--
--   A restart in the middle of a manifest import must not restart the downloads
--   from the top. sync_jobs.status tells us the job died; only this table tells us
--   which of its URLs are already gone.
--
-- The URL itself is never stored. It is a bearer credential: whoever has it can
-- download that export. A sha256 of it is enough to recognise the same URL again
-- and cannot be turned back into one.
CREATE TABLE IF NOT EXISTS claude_export_downloads (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- sha256(export_url), hex. Never the URL.
  url_fingerprint text NOT NULL,
  category text NOT NULL,
  filename text NOT NULL,
  job_id uuid REFERENCES sync_jobs(id) ON DELETE SET NULL,
  -- 'downloaded'  the bytes arrived; the URL is spent and DAMC has the archive
  -- 'consumed'    the server said used/expired; the URL is spent and DAMC does not
  -- 'blocked'     bot-protection challenge; the URL was NOT spent, retry is valid
  -- 'failed'      network/limit failure; may or may not be spent, retry is allowed
  status text NOT NULL,
  bytes bigint,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, url_fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_claude_export_downloads_job
  ON claude_export_downloads(job_id);
