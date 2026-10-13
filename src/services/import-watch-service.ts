/**
 * Watch-folder import.
 *
 * Same pipeline as web upload and CLI: this only decides *when* and *with
 * which provider* runImportJob gets called, never how a conversation is
 * parsed, deduplicated or classified.
 *
 * Off by default. It runs only in-process (an interval timer on the running
 * server), started explicitly from Settings/Import or by DAMC_IMPORT_WATCH_AUTOSTART,
 * and stops the moment the server does — there is no OS-level service.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';
import { openExportSource } from './import-stream-service.js';
import { runStreamingImportJob, type ConversationStreamFactory } from './sync-service.js';
// Type-only: erased at compile time, so the session service (and the connection
// pool behind it) is still only loaded when a package is actually claimed.
import type { ClaimedPackage } from './claude-package-service.js';

/**
 * The watcher hands the importer a factory that opens a fresh conversation
 * stream, never a materialised array — that is what keeps a multi-gigabyte
 * dropped file from being read into memory. Tests substitute their own runner.
 *
 * The stream reads the watched file lazily, so it is only valid for the duration
 * of the call: the watcher moves the file to processed/ or failed/ as soon as the
 * runner resolves. A runner must finish consuming before it returns.
 */
export type ImportRunner = (
  userId: string,
  provider: 'chatgpt' | 'claude',
  conversations: ConversationStreamFactory,
  opts?: { source?: 'web' | 'cli' | 'watch'; fileName?: string }
) => Promise<unknown>;

export type WatchEventStatus = 'detected' | 'stable' | 'unstable' | 'processing' | 'completed' | 'failed';

export interface WatchEvent {
  file: string;
  status: WatchEventStatus;
  provider?: 'chatgpt' | 'claude';
  reason?: 'INVALID_JSON' | 'UNSUPPORTED_PROVIDER' | 'PARSE_ERROR' | 'IMPORT_ERROR' | 'FILE_UNSTABLE'
    | 'ARCHIVE_UNREADABLE' | 'RETAIN_ERROR' | 'MANIFEST_NOT_AN_EXPORT';
  at: string;
  stats?: unknown;
  /** Set when the file was recognised as a package of a Claude export session. */
  packageCategory?: string;
}

/**
 * The Claude-export-session side of the watch folder.
 *
 * A browser-downloaded Claude package is not just any dropped file: it belongs to
 * a session that is waiting for it, and four of the five categories contain no
 * conversations at all. Without this branch `openExportSource` throws
 * CONVERSATIONS_JSON_MISSING for memories/projects/design_chats/light_metadata and
 * the watcher quarantines them in failed/ as "INVALID_JSON" — a single-use download
 * reported as corrupt.
 *
 * It is an injected interface for the same reason `ImportRunner` is: the watcher's
 * own tests must be able to drive the branch without a database, and a watcher
 * that cannot reach Postgres has to behave exactly as it did before.
 */
export interface PackageHook {
  /**
   * Does this file belong to a waiting package? Claiming it also decides how to
   * handle it, from the archive's real entry listing rather than its name.
   */
  claim(userId: string, filename: string, filePath: string): Promise<ClaimedWatchPackage | null>;
  imported(claimed: ClaimedWatchPackage, bytes: number, importJobId: string | null, stats: Record<string, unknown>): Promise<void>;
  retain(claimed: ClaimedWatchPackage, filePath: string): Promise<void>;
  failed(claimed: ClaimedWatchPackage, code: string, message: string): Promise<void>;
}

export interface ClaimedWatchPackage {
  route: 'import' | 'retain' | 'settled' | 'failed';
  package: { id: string; category: string; filename: string; sessionJobId: string };
}

export interface WatcherStatus {
  running: boolean;
  /** The path Node actually watches — inside Docker this is the container-side mount point, not something a Windows Explorer window can open. */
  dir: string;
  /** The Windows path to show/open in the UI. Same as `dir` outside Docker; the real D:\DAMC_IMPORT when `dir` is a container mount point. */
  hostDir: string;
  processedDir: string;
  failedDir: string;
  dirExists: boolean;
  startedAt: string | null;
  lastEvent: WatchEvent | null;
  history: WatchEvent[];
}

/**
 * The production hook: the Claude export session in the database.
 *
 * Imported lazily so this module does not pull the session service — and through
 * it the connection pool — into a watcher that may never see a package. It also
 * keeps the import out of the cycle the session service would otherwise close
 * back through sync-service.
 */
const databasePackageHook: PackageHook = {
  async claim(userId, filename, filePath) {
    const { claimWatchedFile } = await import('./claude-package-service.js');
    const claimed = await claimWatchedFile(userId, filename, filePath);
    if (!claimed) return null;
    // The watcher only needs the route and an identity; the session service keeps
    // the rest, so nothing about a package's internals leaks into this module.
    claimedDetails.set(claimed.package.id, claimed);
    return {
      route: claimed.route,
      package: {
        id: claimed.package.id,
        category: claimed.package.category,
        filename: claimed.package.filename,
        sessionJobId: claimed.package.sessionJobId
      }
    };
  },
  async imported(claimed, bytes, importJobId, stats) {
    const { completeImportedPackage } = await import('./claude-package-service.js');
    const full = claimedDetails.get(claimed.package.id);
    if (!full) return;
    await completeImportedPackage(full, bytes, importJobId, stats);
    claimedDetails.delete(claimed.package.id);
  },
  async retain(claimed, filePath) {
    const { retainPackage } = await import('./claude-package-service.js');
    const full = claimedDetails.get(claimed.package.id);
    if (!full) return;
    await retainPackage(full, filePath);
    claimedDetails.delete(claimed.package.id);
  },
  async failed(claimed, code, message) {
    const { failPackage } = await import('./claude-package-service.js');
    const full = claimedDetails.get(claimed.package.id);
    if (!full) return;
    await failPackage(full, code, message);
    claimedDetails.delete(claimed.package.id);
  }
};

/**
 * The claimed package, in full, between claim and completion.
 *
 * Short-lived by construction: one entry per file currently being processed, and
 * processFile always reaches exactly one of imported/retain/failed. Cleared by
 * _resetForTests along with the rest of this module's state.
 */
const claimedDetails = new Map<string, ClaimedPackage>();

const STABILITY_WAIT_MS = 700;
const HISTORY_LIMIT = 50;
const IMPORTABLE = /\.(json|zip)$/i;

let running = false;
let startedAt: string | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
const inFlight = new Set<string>();
const history: WatchEvent[] = [];

function dirs() {
  const root = env.DAMC_IMPORT_WATCH_DIR;
  return { root, processed: path.join(root, 'processed'), failed: path.join(root, 'failed') };
}

function record(event: WatchEvent) {
  history.unshift(event);
  if (history.length > HISTORY_LIMIT) history.length = HISTORY_LIMIT;
}

export async function ensureWatchFolders() {
  const { root, processed, failed } = dirs();
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(processed, { recursive: true });
  await fs.mkdir(failed, { recursive: true });
  return { root, processed, failed };
}

/**
 * A file mid-copy must never be read. Compares size and mtime across a short
 * wait; only a file that reports the same of both twice in a row is stable.
 */
export async function isFileStable(filePath: string, waitMs = STABILITY_WAIT_MS): Promise<boolean> {
  try {
    const a = await fs.stat(filePath);
    await new Promise(resolve => setTimeout(resolve, waitMs));
    const b = await fs.stat(filePath);
    return a.size === b.size && a.mtimeMs === b.mtimeMs;
  } catch {
    return false;
  }
}

/**
 * `asName` exists for Claude export packages. Two sessions both contain a
 * `conversations-000.zip`, and `fs.rename` replaces an existing destination on
 * every platform DAMC runs on — so filing both under the bare basename would
 * silently destroy the first archive. A package is therefore filed under a
 * session-prefixed name. An ordinary dropped file keeps the name it had.
 */
async function moveTo(filePath: string, kind: 'processed' | 'failed', asName?: string) {
  const { processed, failed } = dirs();
  const dest = path.join(kind === 'processed' ? processed : failed, asName ?? path.basename(filePath));
  try { await fs.rename(filePath, dest); } catch { /* best effort — the job history still records the outcome */ }
}

async function processFile(userId: string, filePath: string, importRunner: ImportRunner, packages: PackageHook) {
  const name = path.basename(filePath);
  if (inFlight.has(name)) return;
  inFlight.add(name);
  try {
    record({ file: name, status: 'detected', at: new Date().toISOString() });

    if (!(await isFileStable(filePath))) {
      record({ file: name, status: 'unstable', reason: 'FILE_UNSTABLE', at: new Date().toISOString() });
      return; // left in place; picked up again on the next scan once it settles
    }
    record({ file: name, status: 'stable', at: new Date().toISOString() });

    // A Claude export package is handled before the conversation reader gets a
    // look at it. It has to be: four of the five categories hold no
    // conversations.json, so the reader would throw and this file — a single-use
    // download the user cannot repeat — would be filed as corrupt.
    //
    // A claim failure is deliberately swallowed to null. Without a reachable
    // database there are no sessions, and the watcher must then behave exactly as
    // it did before this branch existed rather than refusing ordinary files.
    const claimed = await packages.claim(userId, name, filePath).catch(() => null);
    if (claimed) {
      await processPackage(userId, filePath, name, claimed, importRunner, packages);
      return;
    }

    // The Claude export manifest itself lands here, because the browser's download
    // folder is this folder. It is not an export and has no conversations in it, so
    // the reader below would quarantine it as corrupt — the same misreport the
    // upload path already refuses with MANIFEST_DETECTED. Left where it is: the user
    // needs that file to start a session, and deleting or hiding it would be worse.
    if (/\.json$/i.test(name)) {
      const { readManifestFile } = await import('./claude-manifest-service.js');
      if (await readManifestFile(filePath).catch(() => null)) {
        record({ file: name, status: 'failed', reason: 'MANIFEST_NOT_AN_EXPORT', at: new Date().toISOString() });
        return;
      }
    }

    // Read through the streaming path rather than fs.readFile: a watch folder is
    // exactly where someone drops the multi-gigabyte export they just downloaded,
    // and loading it whole would fail the same way the web upload used to. The
    // file is already on disk, so no temp copy is needed — only the extracted
    // ZIP entry is temporary, which `dispose` removes.
    let source;
    try {
      source = await openExportSource(filePath);
    } catch {
      await moveTo(filePath, 'failed');
      record({ file: name, status: 'failed', reason: 'INVALID_JSON', at: new Date().toISOString() });
      return;
    }

    try {
      let provider: 'chatgpt' | 'claude' | null;
      try {
        provider = await source.detectProvider();
      } catch {
        await moveTo(filePath, 'failed');
        record({ file: name, status: 'failed', reason: 'INVALID_JSON', at: new Date().toISOString() });
        return;
      }
      if (!provider) {
        await moveTo(filePath, 'failed');
        record({ file: name, status: 'failed', reason: 'UNSUPPORTED_PROVIDER', at: new Date().toISOString() });
        return;
      }

      record({ file: name, status: 'processing', provider, at: new Date().toISOString() });
      try {
        const stats = await importRunner(userId, provider, report => source!.conversations(provider!, report), { source: 'watch', fileName: name });
        await moveTo(filePath, 'processed');
        record({ file: name, status: 'completed', provider, at: new Date().toISOString(), stats });
      } catch {
        await moveTo(filePath, 'failed');
        record({ file: name, status: 'failed', provider, reason: 'IMPORT_ERROR', at: new Date().toISOString() });
      }
    } finally {
      await source.dispose();
    }
  } finally {
    inFlight.delete(name);
  }
}

/**
 * One claimed Claude export package.
 *
 * `route` came from the archive's own entry listing, so the two branches below are
 * decided by what is in the file, never by what the manifest called its category.
 */
async function processPackage(
  userId: string,
  filePath: string,
  name: string,
  claimed: ClaimedWatchPackage,
  importRunner: ImportRunner,
  packages: PackageHook
) {
  const category = claimed.package.category;
  const filed = `${claimed.package.sessionJobId.slice(0, 8)}-${name}`;
  // Sized before anything moves the file: retaining renames it out from under us.
  const bytes = (await fs.stat(filePath).catch(() => null))?.size ?? 0;
  record({ file: name, status: 'processing', provider: 'claude', packageCategory: category, at: new Date().toISOString() });

  // The claim already failed this package (an unreadable or truncated archive), so
  // the file is filed under the session-prefixed name and the reason is the one the
  // session recorded. Falling through to the ordinary path instead would read the
  // same broken archive again and call it INVALID_JSON.
  if (claimed.route === 'failed') {
    await moveTo(filePath, 'failed', filed);
    record({ file: name, status: 'failed', provider: 'claude', packageCategory: category, reason: 'ARCHIVE_UNREADABLE', at: new Date().toISOString() });
    return;
  }

  // Already dealt with: the user re-downloaded, or copied the files back. Filed
  // away rather than imported again or reported as corrupt — the durable package
  // state is what decides, not the file's presence in the folder.
  if (claimed.route === 'settled') {
    await moveTo(filePath, 'processed', filed);
    record({ file: name, status: 'completed', provider: 'claude', packageCategory: category, at: new Date().toISOString(), stats: { duplicate: true } });
    return;
  }

  if (claimed.route === 'retain') {
    try {
      // retainArchive moves the file into the session's own directory, so there is
      // nothing left in the watch folder to file away afterwards.
      await packages.retain(claimed, filePath);
      record({ file: name, status: 'completed', provider: 'claude', packageCategory: category, at: new Date().toISOString() });
    } catch (error) {
      await packages.failed(claimed, 'RETAIN_ERROR', error instanceof Error ? error.message : 'Could not keep the archive.')
        .catch(() => { /* the watch history still records it */ });
      await moveTo(filePath, 'failed', filed);
      record({ file: name, status: 'failed', provider: 'claude', packageCategory: category, reason: 'RETAIN_ERROR', at: new Date().toISOString() });
    }
    return;
  }

  let source;
  try {
    source = await openExportSource(filePath);
  } catch (error) {
    await packages.failed(claimed, 'ARCHIVE_UNREADABLE',
      error instanceof Error ? error.message : 'The archive could not be read.').catch(() => {});
    await moveTo(filePath, 'failed', filed);
    record({ file: name, status: 'failed', provider: 'claude', packageCategory: category, reason: 'ARCHIVE_UNREADABLE', at: new Date().toISOString() });
    return;
  }

  try {
    // Claude, because this is a Claude export package and the entry listing
    // already confirmed it carries conversation data. The parser is the same one
    // an uploaded Claude ZIP goes through.
    const stats = await importRunner(userId, 'claude', report => source!.conversations('claude', report), { source: 'watch', fileName: name });
    const record_ = (stats ?? {}) as Record<string, unknown>;
    await packages.imported(claimed, bytes, typeof record_.jobId === 'string' ? record_.jobId : null, record_)
      .catch(() => { /* the import itself landed; the session view is what lags */ });
    await moveTo(filePath, 'processed', filed);
    record({ file: name, status: 'completed', provider: 'claude', packageCategory: category, at: new Date().toISOString(), stats });
  } catch (error) {
    await packages.failed(claimed, 'IMPORT_ERROR', error instanceof Error ? error.message : 'The import failed.').catch(() => {});
    await moveTo(filePath, 'failed', filed);
    record({ file: name, status: 'failed', provider: 'claude', packageCategory: category, reason: 'IMPORT_ERROR', at: new Date().toISOString() });
  } finally {
    await source.dispose();
  }
}

/** One pass over the watch folder. Exported so tests and a manual "scan now" can drive it directly. */
export async function scanOnce(
  userId: string,
  importRunner: ImportRunner = runStreamingImportJob,
  packages: PackageHook = databasePackageHook
) {
  const { root, processed, failed } = await ensureWatchFolders();
  let entries: string[] = [];
  try { entries = await fs.readdir(root); } catch { return; }
  for (const entry of entries) {
    const full = path.join(root, entry);
    if (full === processed || full === failed) continue;
    if (!IMPORTABLE.test(entry)) continue;
    const st = await fs.stat(full).catch(() => null);
    if (!st?.isFile()) continue;
    await processFile(userId, full, importRunner, packages);
  }
}

export async function startWatcher(
  userId: string,
  opts: { intervalMs?: number; importRunner?: ImportRunner; packages?: PackageHook } = {}
): Promise<WatcherStatus> {
  if (!running) {
    await ensureWatchFolders();
    running = true;
    startedAt = new Date().toISOString();
    const importRunner = opts.importRunner ?? runStreamingImportJob;
    const packages = opts.packages ?? databasePackageHook;
    timer = setInterval(() => { scanOnce(userId, importRunner, packages).catch(() => {}); }, opts.intervalMs ?? 2000);
    await scanOnce(userId, importRunner, packages);
  }
  return getWatcherStatus();
}

export async function stopWatcher(): Promise<WatcherStatus> {
  if (timer) clearInterval(timer);
  timer = null;
  running = false;
  return getWatcherStatus();
}

export async function getWatcherStatus(): Promise<WatcherStatus> {
  const { root, processed, failed } = dirs();
  const dirExists = await fs.stat(root).then(s => s.isDirectory()).catch(() => false);
  return {
    running, dir: root, hostDir: env.DAMC_IMPORT_WATCH_HOST_DIR || root, processedDir: processed, failedDir: failed, dirExists,
    startedAt, lastEvent: history[0] ?? null, history: history.slice(0, 20)
  };
}

/** Test-only escape hatch: watcher state is module-level so tests can reset it between cases. */
export function _resetForTests() {
  if (timer) clearInterval(timer);
  timer = null;
  running = false;
  startedAt = null;
  history.length = 0;
  inFlight.clear();
  claimedDetails.clear();
}
