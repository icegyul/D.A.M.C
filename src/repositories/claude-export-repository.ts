/**
 * The single-use download ledger.
 *
 * Every attempt against a Claude export_url is recorded here by a hash of the
 * URL, so DAMC can answer "has this one already been used?" across restarts and
 * across repeated uploads of the same manifest.
 *
 * THE URL IS NEVER STORED. An export_url is a bearer credential; a sha256 of it
 * recognises the same URL again without being able to reproduce it. Nothing in
 * this module logs or returns a URL either.
 */

import { createHash } from 'node:crypto';
import { query, withTransaction } from '../db/pool.js';

export type DownloadLedgerStatus = 'downloaded' | 'consumed' | 'blocked' | 'failed';

/** Stable identity for a URL, safe to persist. */
export function fingerprintUrl(url: string): string {
  return createHash('sha256').update(url).digest('hex');
}

/**
 * Statuses that mean the URL is gone. A blocked or failed attempt is retryable:
 * a Cloudflare challenge never reached the file, and a network failure may not
 * have either — so DAMC would rather try again than declare the user's data
 * unreachable on one bad attempt.
 */
const SPENT: DownloadLedgerStatus[] = ['downloaded', 'consumed'];

export interface LedgerEntry {
  urlFingerprint: string;
  category: string;
  filename: string;
  status: DownloadLedgerStatus;
  bytes: number | null;
  jobId: string | null;
  attemptedAt: string;
}

export async function recordDownloadAttempt(
  userId: string,
  input: { url: string; category: string; filename: string; jobId: string | null; status: DownloadLedgerStatus; bytes?: number | null }
): Promise<void> {
  await query(
    `INSERT INTO claude_export_downloads(user_id,url_fingerprint,category,filename,job_id,status,bytes,attempted_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,now())
     ON CONFLICT (user_id,url_fingerprint) DO UPDATE
        SET status=EXCLUDED.status, bytes=EXCLUDED.bytes, job_id=EXCLUDED.job_id,
            attempted_at=now(), category=EXCLUDED.category, filename=EXCLUDED.filename`,
    [userId, fingerprintUrl(input.url), input.category, input.filename, input.jobId, input.status, input.bytes ?? null]
  );
}

/** Ledger rows for the given URLs, keyed by fingerprint. Unknown URLs are absent. */
export async function lookupDownloadAttempts(userId: string, urls: string[]): Promise<Map<string, LedgerEntry>> {
  return lookupByFingerprints(userId, urls.map(fingerprintUrl));
}

/**
 * The same lookup, from fingerprints the caller already has.
 *
 * The browser-download flow needs this: the page hashes each URL itself and sends
 * only the hashes, so the server can recognise a spent link without ever holding
 * one. A fingerprint is not reversible, which is the whole point.
 */
export async function lookupByFingerprints(userId: string, fingerprints: string[]): Promise<Map<string, LedgerEntry>> {
  if (!fingerprints.length) return new Map();
  const result = await query<{
    url_fingerprint: string; category: string; filename: string; status: DownloadLedgerStatus;
    bytes: string | null; job_id: string | null; attempted_at: Date;
  }>(
    `SELECT url_fingerprint,category,filename,status,bytes,job_id,attempted_at
       FROM claude_export_downloads
      WHERE user_id=$1 AND url_fingerprint = ANY($2::text[])`,
    [userId, fingerprints]
  );
  const map = new Map<string, LedgerEntry>();
  for (const row of result.rows) {
    map.set(row.url_fingerprint, {
      urlFingerprint: row.url_fingerprint,
      category: row.category,
      filename: row.filename,
      status: row.status,
      bytes: row.bytes === null ? null : Number(row.bytes),
      jobId: row.job_id,
      attemptedAt: row.attempted_at instanceof Date ? row.attempted_at.toISOString() : String(row.attempted_at)
    });
  }
  return map;
}

export function isSpent(entry: LedgerEntry | undefined): boolean {
  return Boolean(entry && SPENT.includes(entry.status));
}

// ---------------------------------------------------------------------------
// Export packages delivered by the user's own browser.
//
// The rows the browser-download flow runs on. See migrations/007 for why the
// export_url is absent: in this flow it never reaches the server.
// ---------------------------------------------------------------------------

export type PackageStatus =
  | 'awaiting_download'
  | 'opened'
  | 'detected'
  | 'importing'
  | 'imported'
  | 'retained'
  | 'failed'
  | 'superseded';

/** Statuses that mean a file has already arrived, so its URL must never be re-opened. */
export const DELIVERED_STATUSES: PackageStatus[] = ['detected', 'importing', 'imported', 'retained'];

/** Statuses that still need something to happen before the session can settle. */
export const PENDING_STATUSES: PackageStatus[] = ['awaiting_download', 'opened', 'detected', 'importing'];

export interface ExportPackage {
  id: string;
  userId: string;
  sessionJobId: string;
  sequence: number;
  category: string;
  filename: string;
  part: number | null;
  disposition: 'import' | 'retain';
  status: PackageStatus;
  bytes: number | null;
  entryCount: number | null;
  entryNames: string[];
  importJobId: string | null;
  stats: Record<string, unknown> | null;
  errorCode: string | null;
  errorMessage: string | null;
  openedAt: string | null;
  detectedAt: string | null;
  finishedAt: string | null;
}

interface PackageRow {
  id: string; user_id: string; session_job_id: string; sequence: number;
  category: string; filename: string; part: number | null; disposition: string;
  status: PackageStatus; bytes: string | number | null; entry_count: number | null;
  entry_names: unknown; import_job_id: string | null; stats: Record<string, unknown> | null;
  error_code: string | null; error_message: string | null;
  opened_at: Date | string | null; detected_at: Date | string | null; finished_at: Date | string | null;
}

const iso = (value: Date | string | null): string | null =>
  value === null ? null : value instanceof Date ? value.toISOString() : String(value);

function toPackage(row: PackageRow): ExportPackage {
  return {
    id: row.id,
    userId: row.user_id,
    sessionJobId: row.session_job_id,
    sequence: row.sequence,
    category: row.category,
    filename: row.filename,
    part: row.part,
    disposition: row.disposition === 'import' ? 'import' : 'retain',
    status: row.status,
    bytes: row.bytes === null ? null : Number(row.bytes),
    entryCount: row.entry_count,
    entryNames: Array.isArray(row.entry_names) ? row.entry_names as string[] : [],
    importJobId: row.import_job_id,
    stats: row.stats ?? null,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    openedAt: iso(row.opened_at),
    detectedAt: iso(row.detected_at),
    finishedAt: iso(row.finished_at)
  };
}

const PACKAGE_COLUMNS = `id,user_id,session_job_id,sequence,category,filename,part,disposition,status,
  bytes,entry_count,entry_names,import_job_id,stats,error_code,error_message,
  opened_at,detected_at,finished_at`;

export interface NewPackage {
  sequence: number;
  category: string;
  filename: string;
  part: number | null;
  disposition: 'import' | 'retain';
}

/**
 * Create a session's packages, and retire whatever the previous session left
 * waiting.
 *
 * Both halves have to happen together: two live sessions would both be waiting
 * for a file called `conversations-000.zip`, and an arriving file would have no
 * unambiguous owner. Superseding the old one is what keeps filename matching a
 * decision rather than a guess — so it runs in one transaction with the insert.
 */
export async function createPackages(userId: string, sessionJobId: string, packages: NewPackage[]): Promise<{ packages: ExportPackage[]; supersededSessions: string[] }> {
  return withTransaction(async tx => {
    const superseded = await tx.query<{ session_job_id: string }>(
      `UPDATE claude_export_packages
          SET status='superseded', updated_at=now()
        WHERE user_id=$1 AND session_job_id <> $2 AND status = ANY($3::text[])
        RETURNING session_job_id`,
      [userId, sessionJobId, PENDING_STATUSES]
    );
    const supersededSessions = [...new Set(superseded.rows.map(r => r.session_job_id))];
    const created: ExportPackage[] = [];
    for (const entry of packages) {
      const result = await tx.query<PackageRow>(
        `INSERT INTO claude_export_packages(user_id,session_job_id,sequence,category,filename,part,disposition,status)
         VALUES($1,$2,$3,$4,$5,$6,$7,'awaiting_download')
         ON CONFLICT (session_job_id,filename) DO UPDATE
            SET sequence=EXCLUDED.sequence, category=EXCLUDED.category, part=EXCLUDED.part,
                disposition=EXCLUDED.disposition, updated_at=now()
         RETURNING ${PACKAGE_COLUMNS}`,
        [userId, sessionJobId, entry.sequence, entry.category, entry.filename, entry.part, entry.disposition]
      );
      if (result.rows[0]) created.push(toPackage(result.rows[0]));
    }
    // The caller has to settle those sessions' job rows: superseding their packages
    // alone would leave each one parked at 'awaiting_download' for ever, waiting for
    // downloads that will never be offered again.
    return { packages: created, supersededSessions };
  });
}

export async function listPackages(userId: string, sessionJobId: string): Promise<ExportPackage[]> {
  const result = await query<PackageRow>(
    `SELECT ${PACKAGE_COLUMNS} FROM claude_export_packages
      WHERE user_id=$1 AND session_job_id=$2 ORDER BY sequence`,
    [userId, sessionJobId]
  );
  return result.rows.map(toPackage);
}

/** The newest session that still has this user's packages, settled or not. */
export async function latestSessionJobId(userId: string): Promise<string | null> {
  const result = await query<{ session_job_id: string }>(
    `SELECT session_job_id FROM claude_export_packages
      WHERE user_id=$1 AND status <> 'superseded'
      ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  return result.rows[0]?.session_job_id ?? null;
}

/**
 * The package an arriving file belongs to, if any — claimed in the same step.
 *
 * Scoped to packages still waiting for their file, so a package already
 * `imported` cannot be claimed a second time. That is what stops an archive left
 * sitting in the watch folder from being re-imported on every two-second scan:
 * the durable package state is the guard, not the file's location on disk.
 *
 * `FOR UPDATE SKIP LOCKED` because two scans can reach the same name at once; the
 * loser sees no row rather than importing the same archive twice.
 */
export async function claimPackageForFile(userId: string, filename: string): Promise<ExportPackage | null> {
  return withTransaction(async tx => {
    const found = await tx.query<PackageRow>(
      `SELECT ${PACKAGE_COLUMNS} FROM claude_export_packages
        WHERE user_id=$1 AND lower(filename)=lower($2) AND status = ANY($3::text[])
        ORDER BY created_at DESC LIMIT 1
        FOR UPDATE SKIP LOCKED`,
      // 'failed' is claimable on purpose. A package fails on a truncated download
      // or a read error, and the answer to both is to fetch it again — so the row
      // has to be reachable from 'failed', or the "download again" the UI offers
      // for exactly that state would be a button that cannot work.
      [userId, filename, ['awaiting_download', 'opened', 'detected', 'failed']]
    );
    const row = found.rows[0];
    if (!row) return null;
    const claimed = await tx.query<PackageRow>(
      `UPDATE claude_export_packages
          SET status='importing', detected_at=COALESCE(detected_at, now()), updated_at=now(),
              error_code=NULL, error_message=NULL
        WHERE id=$1
        RETURNING ${PACKAGE_COLUMNS}`,
      [row.id]
    );
    return claimed.rows[0] ? toPackage(claimed.rows[0]) : null;
  });
}

/**
 * A package with this filename that is already finished with.
 *
 * Needed because the same download can arrive twice — the user re-downloads, or
 * copies the files back into the folder. Without this the second arrival is not a
 * claimable package any more, so it falls through to ordinary detection: a
 * conversations archive is re-imported (harmlessly, thanks to deduplication) and a
 * retained category is quarantined in failed/ as "INVALID_JSON", which is exactly
 * the misreport this whole feature exists to remove.
 *
 * Deliberately includes 'superseded': a file from a previous export is still a
 * recognised package, not a corrupt upload.
 */
export async function findSettledPackage(userId: string, filename: string): Promise<ExportPackage | null> {
  const result = await query<PackageRow>(
    `SELECT ${PACKAGE_COLUMNS} FROM claude_export_packages
      WHERE user_id=$1 AND lower(filename)=lower($2) AND status = ANY($3::text[])
        -- Only within the newest session. Two exports use the same filenames, so
        -- matching across sessions would make the FIRST export's finished
        -- conversations-000.zip swallow the SECOND export's download and file it away
        -- as a duplicate that was never imported.
        AND session_job_id = (
          SELECT session_job_id FROM claude_export_packages
           WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1)
      ORDER BY created_at DESC LIMIT 1`,
    // 'failed' is absent: a failed package is claimable (see claimPackageForFile),
    // so a re-download must reach the import path, not be filed as already handled.
    [userId, filename, ['imported', 'retained', 'superseded']]
  );
  return result.rows[0] ? toPackage(result.rows[0]) : null;
}

export interface PackagePatch {
  status?: PackageStatus;
  bytes?: number | null;
  entryCount?: number | null;
  entryNames?: string[] | null;
  importJobId?: string | null;
  stats?: Record<string, unknown> | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  finished?: boolean;
}

export async function updatePackage(id: string, patch: PackagePatch): Promise<ExportPackage | null> {
  const result = await query<PackageRow>(
    `UPDATE claude_export_packages
        SET status=COALESCE($2,status),
            bytes=COALESCE($3,bytes),
            entry_count=COALESCE($4,entry_count),
            entry_names=COALESCE($5::jsonb,entry_names),
            import_job_id=COALESCE($6,import_job_id),
            stats=COALESCE($7::jsonb,stats),
            error_code=$8,
            error_message=$9,
            finished_at=CASE WHEN $10 THEN now() ELSE finished_at END,
            updated_at=now()
      WHERE id=$1 AND status <> 'superseded'
      RETURNING ${PACKAGE_COLUMNS}`,
    [id, patch.status ?? null, patch.bytes ?? null, patch.entryCount ?? null,
      patch.entryNames ? JSON.stringify(patch.entryNames) : null,
      patch.importJobId ?? null, patch.stats ? JSON.stringify(patch.stats) : null,
      patch.errorCode ?? null, patch.errorMessage ?? null, Boolean(patch.finished)]
  );
  return result.rows[0] ? toPackage(result.rows[0]) : null;
}

/**
 * Mark a package's download URL as opened.
 *
 * Refuses once a file has arrived. That is the "never re-open a used link" rule
 * enforced where it can actually be enforced — in the state machine rather than
 * in the page: a single-use URL that already produced a file cannot produce
 * another, and offering the button again would only teach the user that DAMC
 * lies about what is possible. Re-opening a package that was opened but never
 * arrived is allowed, because that download may never have started.
 */
export async function markPackageOpened(userId: string, packageId: string): Promise<ExportPackage | null> {
  const result = await query<PackageRow>(
    `UPDATE claude_export_packages
        SET status='opened', opened_at=COALESCE(opened_at, now()), updated_at=now()
      WHERE id=$1 AND user_id=$2 AND status = ANY($3::text[])
      RETURNING ${PACKAGE_COLUMNS}`,
    // 'failed' included: re-opening the link is the documented recovery from a
    // truncated or unreadable download, and it is what the UI offers for that row.
    [packageId, userId, ['awaiting_download', 'opened', 'failed']]
  );
  return result.rows[0] ? toPackage(result.rows[0]) : null;
}

/** Every package still waiting, across all users. Used by boot reconciliation. */
export async function listPendingPackages(): Promise<ExportPackage[]> {
  const result = await query<PackageRow>(
    `SELECT ${PACKAGE_COLUMNS} FROM claude_export_packages
      WHERE status = ANY($1::text[]) ORDER BY created_at`,
    [PENDING_STATUSES]
  );
  return result.rows.map(toPackage);
}

/**
 * Undo an interrupted package import at boot.
 *
 * A package in `importing` or `detected` when the process died describes work
 * that cannot resume on its own. It goes back to `opened`, never to
 * `awaiting_download`: the file was already downloaded, so presenting its URL as
 * untouched would invite a click on a link that is spent. If the archive is still
 * in the watch folder the watcher re-detects it within one scan and the session
 * carries on by itself.
 */
export async function resetInterruptedPackages(): Promise<number> {
  const result = await query(
    `UPDATE claude_export_packages
        SET status='opened', updated_at=now()
      WHERE status IN ('detected','importing')
      RETURNING id`
  );
  return result.rowCount ?? 0;
}
