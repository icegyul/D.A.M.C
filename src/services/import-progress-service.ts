/**
 * Live progress for a running import.
 *
 * Two tiers, because they answer different questions:
 *
 *   In memory — what is happening right now, updated per conversation. Cheap
 *   enough to poll, and gone when the process ends.
 *
 *   sync_jobs.stats.progress — the durable record, written once per batch. This
 *   is what survives a restart, and it is why an interrupted import can be told
 *   apart from one that never started: the row keeps the last committed count.
 *
 * Deliberately not a new table. `sync_jobs` already is the import history that
 * /v1/sync/jobs and the dashboard read; progress belongs on the job it describes.
 */

import { query } from '../db/pool.js';

/**
 * Where an import has got to.
 *
 * 'reading' | 'importing' | 'finished' describe a single uploaded file, and are
 * unchanged. A Claude manifest import is a sequence of downloads and imports
 * rather than one file, so it adds 'queued' and 'downloading' — the two states
 * that exist only when DAMC is fetching the archives itself.
 */
export type ImportPhase = 'queued' | 'downloading' | 'reading' | 'importing' | 'finished';

export interface ImportProgress {
  jobId: string;
  /** Who owns this import. Every read is scoped to it; see listActiveProgress. */
  userId: string;
  provider: 'chatgpt' | 'claude';
  fileName: string | null;
  /** Conversations read off the export so far. Total is unknown while streaming. */
  processed: number;
  imported: number;
  deduplicated: number;
  failed: number;
  memoriesCreated: number;
  /** Shards in this export (1 for a single conversations.json or a bare .json). */
  shardsTotal: number;
  /** Shards fully read so far. */
  shardsProcessed: number;
  /** Entry name of the shard being read, '' for a single-document export. */
  currentShard: string;
  startedAt: string;
  updatedAt: string;
  phase: ImportPhase;

  // --- Manifest imports only. Absent for a single-file upload. -----------------
  /** 'file' for an uploaded export, 'manifest' when DAMC is fetching the archives. */
  mode?: 'file' | 'manifest';
  /** Category archives the manifest declares. */
  totalFiles?: number;
  /** Archives fetched so far (a retained, unparsed category still counts). */
  filesDownloaded?: number;
  /** Archives whose conversations have been ingested. */
  filesImported?: number;
  /** Category currently being fetched or imported, e.g. 'conversations'. */
  currentCategory?: string | null;
}

const active = new Map<string, ImportProgress>();

export function beginProgress(
  jobId: string,
  provider: 'chatgpt' | 'claude',
  fileName: string | null,
  now: string,
  extra: Partial<ImportProgress> = {},
  userId = ''
): ImportProgress {
  const progress: ImportProgress = {
    jobId, userId, provider, fileName,
    processed: 0, imported: 0, deduplicated: 0, failed: 0, memoriesCreated: 0,
    shardsTotal: 1, shardsProcessed: 0, currentShard: '',
    startedAt: now, updatedAt: now, phase: 'reading',
    ...extra
  };
  active.set(jobId, progress);
  return progress;
}

export function updateProgress(jobId: string, patch: Partial<ImportProgress>, now: string): void {
  const current = active.get(jobId);
  if (!current) return;
  Object.assign(current, patch, { updatedAt: now });
}

export function endProgress(jobId: string): void {
  active.delete(jobId);
}

/**
 * One import's progress — only for the user who started it.
 *
 * An import's file name and counters are that user's business. Without the owner
 * check any caller holding a job id could watch anyone's import, and these were the
 * only /v1 data routes in the app not scoped to the caller.
 */
export function getProgress(jobId: string, userId?: string): ImportProgress | null {
  const progress = active.get(jobId) ?? null;
  if (!progress) return null;
  if (userId && progress.userId && progress.userId !== userId) return null;
  return progress;
}

/** Newest-first view of this user's imports running in this process. */
export function listActiveProgress(userId?: string): ImportProgress[] {
  return [...active.values()]
    .filter(p => !userId || !p.userId || p.userId === userId)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** Persist the counters onto the job row so they outlive the process. */
export async function persistProgress(jobId: string, progress: ImportProgress): Promise<void> {
  await query(
    `UPDATE sync_jobs
        SET stats = COALESCE(stats, '{}'::jsonb) || jsonb_build_object('progress', $2::jsonb)
      WHERE id = $1`,
    [jobId, JSON.stringify({
      processed: progress.processed,
      imported: progress.imported,
      deduplicated: progress.deduplicated,
      failed: progress.failed,
      memoriesCreated: progress.memoriesCreated,
      shardsTotal: progress.shardsTotal,
      shardsProcessed: progress.shardsProcessed,
      currentShard: progress.currentShard,
      phase: progress.phase,
      // Manifest fields are written only when present, so a single-file import's
      // persisted progress keeps exactly the shape it had before.
      ...(progress.mode ? {
        mode: progress.mode,
        totalFiles: progress.totalFiles ?? 0,
        filesDownloaded: progress.filesDownloaded ?? 0,
        filesImported: progress.filesImported ?? 0,
        currentCategory: progress.currentCategory ?? null
      } : {}),
      updatedAt: progress.updatedAt
    })]
  );
}

/**
 * Mark imports that were running when the process died.
 *
 * Called at boot. An import holds its job row in 'running' for as long as it
 * streams, so a row still in 'running' after a restart describes work that can
 * never finish. Leaving it would show a permanent spinner in the Sync Center and
 * hide the fact that the import has to be repeated — which is safe to do,
 * because conversation-level deduplication makes a re-run idempotent.
 */
export async function failInterruptedImports(): Promise<number> {
  const result = await query(
    `UPDATE sync_jobs
        SET status='failed',
            finished_at=now(),
            error_message='Interrupted by a server restart. Re-run the import — already-imported conversations are skipped.'
      WHERE status IN ('running','queued')
      RETURNING id`
  );
  return result.rowCount ?? 0;
}
