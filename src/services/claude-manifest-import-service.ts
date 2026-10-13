/**
 * Importing a Claude export from its manifest.
 *
 * One job, N archives. For each entry the manifest lists, in the order
 * orderForImport chose:
 *
 *   queued -> downloading -> (importing | retaining) -> next
 *
 * and at the end the job settles on completed / partial / failed. The user hands
 * DAMC one small JSON file and gets their conversations; nothing is downloaded in
 * their browser and nothing is re-uploaded by hand.
 *
 * Four properties this orchestration has to hold.
 *
 * NOTHING IS BUFFERED. Each archive is streamed to a temp file by
 * claude-download-service and read back one conversation at a time by the same
 * streaming importer an uploaded file goes through. A multi-gigabyte conversations
 * archive costs a temp file, not its own size in memory.
 *
 * A SINGLE-USE URL IS FETCHED AT MOST ONCE. Every attempt is written to the
 * download ledger before the next file is touched, so a re-submitted manifest, or
 * one resumed after a restart, skips what is already spent instead of fetching a
 * URL that can only fail. This is also why the loop is sequential: two files in
 * flight at once would double the chance of losing one to a crash between the
 * fetch and the ledger write.
 *
 * A CATEGORY IS NEVER GUESSED AT. Only `conversations` has a structure DAMC has
 * seen, so only `conversations` is parsed. The other archives are kept and their
 * real entry listing recorded — see claude-category-service.ts for why that is the
 * honest answer rather than a gap.
 *
 * FAILING ONE FILE DOES NOT FAIL THE REST. The archives are independent, so each
 * is attempted on its own and its outcome recorded; the job reports which
 * succeeded and which did not. The exception is a bot-protection challenge, which
 * is not a per-file problem — it means server-side downloading cannot work at all
 * right now, so the remaining files are left untouched (and their URLs unspent)
 * and the user is told to fetch the archives from their browser instead.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { query } from '../db/pool.js';
import { env } from '../config/env.js';
import { AppError } from '../errors/app-error.js';
import { createSyncJob, createStreamCounters, ingestConversationStream } from './sync-service.js';
import { beginProgress, updateProgress, endProgress, persistProgress, type ImportProgress } from './import-progress-service.js';
import { downloadExportPackage, maskUrl } from './claude-download-service.js';
import { openExportSource } from './import-stream-service.js';
import { importTempDir } from './import-upload-service.js';
import { isImportable, retainArchive, CATEGORY_DISPOSITION } from './claude-category-service.js';
import { recordDownloadAttempt, lookupDownloadAttempts, isSpent, fingerprintUrl, type DownloadLedgerStatus } from '../repositories/claude-export-repository.js';
import type { ClaudeManifest, ClaudeManifestFile } from './claude-manifest-service.js';

/** Per-file outcome, recorded on the job so the UI can account for every archive. */
export type ManifestFileStatus =
  | 'queued'
  | 'downloading'
  | 'importing'
  | 'imported'
  | 'retained'
  | 'already_used'
  | 'blocked'
  | 'skipped'
  | 'failed';

export interface ManifestFileOutcome {
  category: string;
  filename: string;
  status: ManifestFileStatus;
  bytes: number | null;
  /** Conversations read out of this archive. Null for a category DAMC does not parse. */
  conversations: number | null;
  imported: number | null;
  deduplicated: number | null;
  memoriesCreated: number | null;
  /** Entries counted inside a retained archive — the observed structure, not a guess. */
  entryCount: number | null;
  entryNames: string[];
  retainedPath: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface ManifestJobStats {
  mode: 'manifest';
  source: 'web' | 'cli';
  manifestVersion: string | null;
  manifestCreatedAt: string | null;
  totalFiles: number;
  filesDownloaded: number;
  filesImported: number;
  currentCategory: string | null;
  downloadedBytes: number;
  files: ManifestFileOutcome[];
  // The same counters a file import records, so the completion banner and the
  // Sync Center read a manifest job exactly as they read an uploaded one.
  conversationsDetected: number;
  messages: number;
  imported: number;
  deduplicated: number;
  memoriesCreated: number;
  superseded: number;
  decisionCount: number;
  taskCount: number;
  errors: Array<{ conversation: string; message: string }>;
  /** Set when downloading cannot work at all; the UI turns this into instructions. */
  blockedByChallenge: boolean;
}

export interface ManifestImportOptions {
  source?: 'web' | 'cli';
  /** Injected by tests; production uses the real network. */
  fetchImpl?: typeof fetch;
}

export interface ManifestImportHandle {
  jobId: string;
  /** Resolves when the job has settled. The route does not await it. */
  done: Promise<ManifestJobStats>;
}

/**
 * Start a manifest import. The job row exists before this returns, so the caller
 * can hand back a jobId immediately and let the dashboard poll progress — a
 * five-file, multi-gigabyte download is not something to hold an HTTP request
 * open for.
 */
export async function startManifestImport(
  userId: string,
  manifest: ClaudeManifest,
  opts: ManifestImportOptions = {}
): Promise<ManifestImportHandle> {
  const jobId = await createSyncJob(userId, 'claude');
  const done = runManifestImport(userId, jobId, manifest, opts);
  // The caller may ignore `done`; make sure a rejection is never unhandled.
  done.catch(() => { /* the failure is already recorded on the job row */ });
  return { jobId, done };
}

/** Await the whole thing. Used by tests and by any caller that wants the result. */
export async function runManifestImportJob(
  userId: string,
  manifest: ClaudeManifest,
  opts: ManifestImportOptions = {}
): Promise<{ jobId: string; stats: ManifestJobStats; status: string }> {
  const handle = await startManifestImport(userId, manifest, opts);
  const stats = await handle.done;
  return { jobId: handle.jobId, stats, status: settledStatus(stats) };
}

function blankOutcome(file: ClaudeManifestFile): ManifestFileOutcome {
  return {
    category: file.category, filename: file.filename, status: 'queued',
    bytes: null, conversations: null, imported: null, deduplicated: null, memoriesCreated: null,
    entryCount: null, entryNames: [], retainedPath: null, errorCode: null, errorMessage: null
  };
}

/**
 * completed only when every file landed.
 *
 * Three groups, because a manifest can end three genuinely different ways:
 *
 *   landed      imported or retained — DAMC has the archive.
 *   unresolved  something went wrong, or never ran: failed, blocked, still queued.
 *   spent       the link was already used, so there is nothing DAMC can do about it.
 *
 * A manifest whose conversations imported but whose `projects` link was spent is
 * 'partial': the user has most of what they came for and has to be told the rest
 * is gone. Nothing at all is 'failed' — except when the *only* reason nothing
 * arrived is that every link had already been used, which is not a breakage and
 * must not be reported as one.
 */
function settledStatus(stats: ManifestJobStats): 'awaiting_download' | 'completed' | 'partial' | 'failed' {
  const count = (...statuses: ManifestFileStatus[]) => stats.files.filter(f => statuses.includes(f.status)).length;
  const landed = count('imported', 'retained');
  const unresolved = count('failed', 'blocked', 'queued', 'downloading', 'importing');
  const spent = count('already_used', 'skipped');

  // Bot protection is not a failed import — it is a path that does not work, with
  // another path still open. The packages were never fetched, so their links are
  // untouched and the user can download them in their own browser; saying "failed"
  // here would tell them their export is gone when it is not. The job parks at
  // 'awaiting_download', which is also deliberately outside the ('running','queued')
  // set that boot reconciliation fails.
  if (stats.blockedByChallenge && landed === 0) return 'awaiting_download';

  if (landed === 0) return unresolved > 0 || spent === 0 ? 'failed' : 'partial';
  if (unresolved > 0 || spent > 0 || stats.errors.length > 0) return 'partial';
  return 'completed';
}

async function runManifestImport(
  userId: string,
  jobId: string,
  manifest: ClaudeManifest,
  opts: ManifestImportOptions
): Promise<ManifestJobStats> {
  const stats: ManifestJobStats = {
    mode: 'manifest',
    source: opts.source ?? 'web',
    manifestVersion: manifest.version,
    manifestCreatedAt: manifest.createdAt,
    totalFiles: manifest.files.length,
    filesDownloaded: 0,
    filesImported: 0,
    currentCategory: null,
    downloadedBytes: 0,
    files: manifest.files.map(blankOutcome),
    conversationsDetected: 0, messages: 0, imported: 0, deduplicated: 0,
    memoriesCreated: 0, superseded: 0, decisionCount: 0, taskCount: 0, errors: [],
    blockedByChallenge: false
  };

  const progress = beginProgress(jobId, 'claude', manifest.files[0]?.filename ?? null, new Date().toISOString(), {
    phase: 'queued', mode: 'manifest', totalFiles: stats.totalFiles,
    filesDownloaded: 0, filesImported: 0, currentCategory: null
  }, userId);

  const publish = async (phase: ImportProgress['phase']) => {
    const patch: Partial<ImportProgress> = {
      phase,
      processed: stats.conversationsDetected,
      imported: stats.imported,
      deduplicated: stats.deduplicated,
      failed: stats.errors.length,
      memoriesCreated: stats.memoriesCreated,
      mode: 'manifest',
      totalFiles: stats.totalFiles,
      filesDownloaded: stats.filesDownloaded,
      filesImported: stats.filesImported,
      currentCategory: stats.currentCategory
    };
    updateProgress(jobId, patch, new Date().toISOString());
    await persistProgress(jobId, { ...progress, ...patch } as ImportProgress)
      .catch(() => { /* progress is advisory; never fail an import over it */ });
    // The per-file table is what the UI renders, and it only lives in stats.
    await writeStats(jobId, stats, 'running').catch(() => { /* same */ });
  };

  await query(`UPDATE sync_jobs SET status='running' WHERE id=$1`, [jobId]);
  await publish('queued');

  // One lookup for the whole manifest: a URL already spent is not fetched again.
  const ledger = await lookupDownloadAttempts(userId, manifest.files.map(f => f.exportUrl))
    .catch(() => new Map());

  const tempDir = importTempDir();
  await fs.mkdir(tempDir, { recursive: true });

  try {
    for (const [index, file] of manifest.files.entries()) {
      const outcome = stats.files[index]!;
      stats.currentCategory = file.category;

      // Requirement: a spent URL is never re-fetched. Reported as its own state so
      // the user can tell "already imported" from "download failed".
      const previous = ledger.get(fingerprintUrl(file.exportUrl));
      if (isSpent(previous)) {
        outcome.status = 'already_used';
        outcome.errorCode = 'DOWNLOAD_URL_CONSUMED';
        outcome.errorMessage = 'This download link was already used by an earlier import.';
        await publish('queued');
        continue;
      }

      // Once a challenge is seen, every further fetch would hit the same wall.
      // Leaving the rest untouched keeps their URLs unspent, which is the whole
      // reason the user can still fetch them from a browser.
      if (stats.blockedByChallenge) {
        outcome.status = 'skipped';
        outcome.errorCode = 'DOWNLOAD_BLOCKED_BY_CHALLENGE';
        outcome.errorMessage = 'Not attempted: an earlier file was blocked by bot protection, so this link is still unused.';
        continue;
      }

      outcome.status = 'downloading';
      await publish('downloading');

      const targetPath = path.join(tempDir, `claude-${file.category}-${randomUUID()}.zip`);
      let downloaded: { bytes: number } | null = null;
      try {
        downloaded = await downloadExportPackage(file.exportUrl, targetPath, { fetchImpl: opts.fetchImpl });
        outcome.bytes = downloaded.bytes;
        stats.filesDownloaded++;
        stats.downloadedBytes += downloaded.bytes;
        await note(userId, file, jobId, 'downloaded', downloaded.bytes);
      } catch (error) {
        const app = error instanceof AppError ? error : null;
        const code = app?.code ?? 'DOWNLOAD_FAILED';
        outcome.errorCode = code;
        // maskUrl, not the URL: an export_url in a job row is a live credential.
        outcome.errorMessage = app?.message ?? (error instanceof Error ? error.message : 'Download failed');
        if (code === 'DOWNLOAD_BLOCKED_BY_CHALLENGE') {
          outcome.status = 'blocked';
          stats.blockedByChallenge = true;
          await note(userId, file, jobId, 'blocked', null);
        } else if (code === 'DOWNLOAD_URL_CONSUMED') {
          outcome.status = 'already_used';
          await note(userId, file, jobId, 'consumed', null);
        } else {
          outcome.status = 'failed';
          await note(userId, file, jobId, 'failed', null);
        }
        await fs.rm(targetPath, { force: true }).catch(() => { /* swept later */ });
        await publish('downloading');
        continue;
      }

      try {
        if (isImportable(file.category)) {
          outcome.status = 'importing';
          await publish('importing');
          await importConversationArchive(userId, jobId, targetPath, stats, outcome, publish);
          outcome.status = 'imported';
          stats.filesImported++;
        } else {
          // Kept, listed, not parsed. See claude-category-service.ts.
          const retained = await retainArchive(jobId, file.filename, targetPath);
          outcome.status = 'retained';
          outcome.bytes = retained.bytes;
          outcome.entryCount = retained.entryCount;
          outcome.entryNames = retained.entries.map(e => e.name);
          outcome.retainedPath = retained.path;
        }
      } catch (error) {
        outcome.status = 'failed';
        outcome.errorCode = error instanceof AppError ? error.code : 'IMPORT_FAILED';
        outcome.errorMessage = error instanceof Error ? error.message : String(error);
      } finally {
        // retainArchive moves the file; rm is a no-op then and the cleanup that
        // matters after an import or a failure.
        await fs.rm(targetPath, { force: true }).catch(() => { /* swept later */ });
      }
      await publish('importing');
    }
  } finally {
    stats.currentCategory = null;
    endProgress(jobId);
  }

  const status = settledStatus(stats);
  await writeStats(jobId, stats, status, errorSummary(stats));
  return stats;
}

async function note(
  userId: string,
  file: ClaudeManifestFile,
  jobId: string,
  status: DownloadLedgerStatus,
  bytes: number | null
): Promise<void> {
  await recordDownloadAttempt(userId, {
    url: file.exportUrl, category: file.category, filename: file.filename,
    jobId, status, bytes
  }).catch(() => { /* the ledger is a safety net, not a gate on the import */ });
}

/**
 * Read one conversations archive into the job, through the same streaming path an
 * uploaded Claude ZIP takes.
 *
 * Counters accumulate across archives: a manifest that ships conversations-000.zip
 * and conversations-001.zip is one import of one user's history, and the banner
 * should say so.
 */
async function importConversationArchive(
  userId: string,
  jobId: string,
  archivePath: string,
  stats: ManifestJobStats,
  outcome: ManifestFileOutcome,
  publish: (phase: ImportProgress['phase']) => Promise<void>
): Promise<void> {
  const source = await openExportSource(archivePath);
  try {
    const counters = createStreamCounters();
    // Totals as they stood before this archive. The job counters are recomputed
    // from this baseline on every batch rather than incremented, so a mid-archive
    // progress write can never double-count.
    const before = {
      detected: stats.conversationsDetected, messages: stats.messages, imported: stats.imported,
      deduplicated: stats.deduplicated, memories: stats.memoriesCreated,
      superseded: stats.superseded, decisions: stats.decisionCount, tasks: stats.taskCount
    };
    const roll = () => {
      stats.conversationsDetected = before.detected + counters.attempted;
      stats.messages = before.messages + counters.messages;
      stats.imported = before.imported + counters.imported;
      stats.deduplicated = before.deduplicated + counters.deduplicated;
      stats.memoriesCreated = before.memories + counters.memoriesCreated;
      stats.superseded = before.superseded + counters.superseded;
      stats.decisionCount = before.decisions + counters.decisionCount;
      stats.taskCount = before.tasks + counters.taskCount;
    };

    await ingestConversationStream(userId, report => source.conversations('claude', report), counters, {
      onBatch: async () => { roll(); await publish('importing'); }
    });

    roll();
    stats.errors.push(...counters.errors.slice(0, 20));

    outcome.conversations = counters.attempted;
    outcome.imported = counters.imported;
    outcome.deduplicated = counters.deduplicated;
    outcome.memoriesCreated = counters.memoriesCreated;
    outcome.entryCount = source.info.shardCount;
    outcome.entryNames = source.info.shardNames;
  } finally {
    await source.dispose();
  }
}

function errorSummary(stats: ManifestJobStats): string | null {
  if (stats.blockedByChallenge) {
    return 'Claude answered with a bot-protection challenge, so DAMC could not download the export packages. Download them from your browser and import the ZIP files directly.';
  }
  const bad = stats.files.filter(f => f.status === 'failed' || f.status === 'already_used');
  if (bad.length) {
    return `${bad.length}/${stats.totalFiles} export file(s) could not be imported: ${bad.map(f => `${f.category} (${f.errorCode ?? 'unknown'})`).join(', ')}`;
  }
  if (stats.errors.length) return `${stats.errors.length} conversation(s) failed`;
  return null;
}

async function writeStats(
  jobId: string,
  stats: ManifestJobStats,
  status: 'running' | 'awaiting_download' | 'completed' | 'partial' | 'failed',
  errorMessage: string | null = null
): Promise<void> {
  // stats is merged, never replaced, so the `progress` key written by
  // persistProgress survives.
  if (status === 'running') {
    await query(
      `UPDATE sync_jobs SET stats=COALESCE(stats,'{}'::jsonb)||$1::jsonb WHERE id=$2`,
      [JSON.stringify(stats), jobId]
    );
    return;
  }
  await query(
    `UPDATE sync_jobs SET status=$1,finished_at=now(),stats=COALESCE(stats,'{}'::jsonb)||$2::jsonb,error_message=$3 WHERE id=$4`,
    [status, JSON.stringify(stats), errorMessage, jobId]
  );
}

/** Retained archives on disk for a job, for the UI's "where did my files go" answer. */
export async function listRetainedArchives(jobId: string): Promise<Array<{ name: string; bytes: number }>> {
  const dir = path.join(env.DATA_DIR, 'claude-export', jobId);
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  const out: Array<{ name: string; bytes: number }> = [];
  for (const name of names) {
    const stat = await fs.stat(path.join(dir, name)).catch(() => null);
    if (stat?.isFile()) out.push({ name, bytes: stat.size });
  }
  return out;
}

/** Re-exported so routes can mask a URL without importing the download service. */
export { maskUrl };
export { CATEGORY_DISPOSITION };
