/**
 * Claude export packages, delivered by the user's own browser.
 *
 * WHY THIS PATH IS THE DEFAULT. Claude's manifest lists five archives behind
 * single-use URLs, and claude.ai answers a server-side fetch with a Cloudflare
 * bot-protection page. DAMC will not impersonate a browser to get past that, so
 * the browser that is already logged in does the download — exactly what Claude's
 * own `instructions` field tells the user to do — and DAMC picks the files up from
 * the watch folder it already has.
 *
 * The consequence worth stating plainly: **no export_url reaches the server on
 * this path.** The dashboard parses the manifest locally and keeps the URLs in
 * browser memory. A bearer credential granting one download of the user's entire
 * history is never written to a database that the GitHub backup adapter copies
 * elsewhere. What the server stores is category, filename and part — none of it
 * secret, all of it needed to recognise an arriving file.
 *
 * THE SESSION. Five packages, each in its own state:
 *
 *   awaiting_download -> opened -> detected -> importing -> imported | retained
 *                                                        -> failed
 *
 * The session job sits at sync_jobs.status = 'awaiting_download' for as long as
 * any package is pending. That status is load-bearing: boot reconciliation fails
 * every job in ('running','queued'), and a session legitimately waits on a human
 * for minutes or hours across container restarts, so it must not be in either.
 *
 * ROUTING IS BY CONTENTS, NOT BY NAME. The manifest's category is a hint recorded
 * on the package; what actually decides is the archive's own entry listing, read
 * without decompressing anything. An archive containing conversations.json (or its
 * numbered shards) is imported through the existing streaming importer whatever
 * its category is called; one that does not is retained with its real entry names
 * recorded, never parsed. So a `design_chats` package that turns out to hold
 * conversations is imported on the evidence, and nothing is ever mapped from a
 * guess about what a category name means.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { query } from '../db/pool.js';
import { AppError } from '../errors/app-error.js';
import { createSyncJob } from './sync-service.js';
import { inspectArchiveEntries, selectConversationEntries } from './import-archive-service.js';
import { isImportable, retainArchive, retainedArchiveDir, CATEGORY_DISPOSITION } from './claude-category-service.js';
import { normalizeDownloadFilename, CATEGORY_PRIORITY } from './claude-manifest-service.js';
import {
  createPackages, listPackages, latestSessionJobId, claimPackageForFile, findSettledPackage,
  listPendingPackages, updatePackage, markPackageOpened, PENDING_STATUSES, DELIVERED_STATUSES,
  type ExportPackage, type NewPackage
} from '../repositories/claude-export-repository.js';

/**
 * How many entry names to read when deciding how to route an archive.
 *
 * Generous rather than tidy: a real provider export is mostly attached media, and
 * conversations.json can be the nine-hundredth entry. Reading names costs strings,
 * not decompression, so the cap is only here to stop a hostile archive from
 * turning a listing into unbounded memory.
 */
const ROUTING_ENTRY_LIMIT = 20_000;

/** How many entry names to keep on the package row as recorded evidence. */
const RECORDED_ENTRY_LIMIT = 50;

export interface PackagePlanEntry {
  category: string;
  filename: string;
  part: number | null;
}

export interface SessionSummaryCategory {
  category: string;
  disposition: 'import' | 'retain';
  status: string;
  /** Conversations read out of this category. Null when nothing was parsed. */
  conversations: number | null;
  messages: number | null;
  memoriesCreated: number | null;
  /** Archives kept for a category DAMC does not parse. */
  kept: number;
  /** Entries observed inside those archives — real counts, not an interpretation. */
  entries: number | null;
}

export interface SessionSummary {
  jobId: string;
  status: 'awaiting_download' | 'completed' | 'partial' | 'failed' | 'superseded';
  mode: 'manifest';
  delivery: 'browser';
  totalFiles: number;
  delivered: number;
  settled: number;
  pending: number;
  conversations: number;
  messages: number;
  imported: number;
  deduplicated: number;
  memoriesCreated: number;
  decisionCount: number;
  taskCount: number;
  retainedArchives: number;
  byCategory: SessionSummaryCategory[];
  packages: ExportPackage[];
}

/**
 * The plan the dashboard posts: what to expect, with no URLs in it.
 *
 * Ordered conversations-first, not in manifest order. The sequence number decides
 * which package the user is offered next, and a real manifest happens to list
 * conversations last — so trusting its order would have the user spend four
 * one-time links on categories DAMC only keeps before reaching the one they came
 * for. Ordered here rather than in the page so any caller gets it.
 */
export function planFromEntries(entries: PackagePlanEntry[]): NewPackage[] {
  if (!entries.length) {
    throw new AppError('MANIFEST_NO_DATA_FILES', 'The manifest lists no packages.', 400);
  }
  const rank = (category: string) => {
    const index = (CATEGORY_PRIORITY as readonly string[]).indexOf(category);
    return index === -1 ? CATEGORY_PRIORITY.length : index;
  };
  const ordered = [...entries].sort((a, b) =>
    rank(String(a.category ?? '')) - rank(String(b.category ?? '')) ||
    (a.part ?? 0) - (b.part ?? 0) ||
    String(a.filename ?? '').localeCompare(String(b.filename ?? '')));

  const seen = new Set<string>();
  return ordered.map((entry, index) => {
    const filename = path.basename(String(entry.filename ?? '').trim());
    if (!filename) {
      throw new AppError('MANIFEST_ENTRY_INVALID', `Package ${index + 1} has no filename.`, 400);
    }
    // Defence in depth: a URL must never arrive here, and if one does it is a bug
    // in the client that would otherwise persist a credential silently.
    for (const value of Object.values(entry)) {
      if (typeof value === 'string' && value.includes('://')) {
        throw new AppError('MANIFEST_URL_NOT_ACCEPTED',
          'This endpoint takes the package list only. Download URLs are handled in your browser and must not be sent to the server.', 400);
      }
    }
    const key = normalizeDownloadFilename(filename);
    if (seen.has(key)) {
      throw new AppError('MANIFEST_ENTRY_INVALID',
        `The manifest lists "${filename}" more than once; DAMC cannot tell two downloads of the same name apart.`, 400);
    }
    seen.add(key);
    const category = String(entry.category ?? '').trim() || 'unknown';
    return {
      sequence: index + 1,
      category,
      filename,
      part: typeof entry.part === 'number' ? entry.part : null,
      disposition: (CATEGORY_DISPOSITION[category]?.action ?? (isImportable(category) ? 'import' : 'retain')) as 'import' | 'retain'
    };
  });
}

/**
 * Open a browser-download session for one manifest.
 *
 * The job row is created and immediately parked at 'awaiting_download' — not left
 * at the 'queued' default, which boot reconciliation would fail the next time the
 * container restarts.
 */
export async function startSession(userId: string, entries: PackagePlanEntry[], meta: { version?: string | null; createdAt?: string | null } = {}): Promise<SessionSummary> {
  const plan = planFromEntries(entries);
  const jobId = await createSyncJob(userId, 'claude');
  await query(
    `UPDATE sync_jobs SET status='awaiting_download', stats=COALESCE(stats,'{}'::jsonb)||$1::jsonb WHERE id=$2`,
    [JSON.stringify({
      mode: 'manifest', delivery: 'browser', source: 'web',
      manifestVersion: meta.version ?? null, manifestCreatedAt: meta.createdAt ?? null,
      totalFiles: plan.length
    }), jobId]
  );
  const created = await createPackages(userId, jobId, plan);
  // A session this one replaced still has a job row parked at 'awaiting_download'.
  // Settle each of them now, or they wait for ever on downloads that will never be
  // offered again — and the Sync Center shows a job that can never finish.
  for (const previous of created.supersededSessions) {
    await settleSession(userId, previous).catch(() => { /* the new session matters more */ });
  }
  return settleSession(userId, jobId);
}

/** The session to show: an explicit job, else this user's newest. */
export async function getSession(userId: string, jobId?: string | null): Promise<SessionSummary | null> {
  const id = jobId ?? await latestSessionJobId(userId);
  if (!id) return null;
  const packages = await listPackages(userId, id);
  if (!packages.length) return null;
  return summarize(id, packages);
}

/**
 * Record that the user opened a package's download URL in their browser.
 *
 * Refused once the file has arrived — the state machine owns that rule, not the
 * page, because a single-use URL that already produced a file cannot produce
 * another and a second click would only waste the user's time.
 */
export async function openPackage(userId: string, packageId: string): Promise<ExportPackage> {
  const updated = await markPackageOpened(userId, packageId);
  if (updated) return updated;
  throw new AppError('PACKAGE_ALREADY_DELIVERED',
    'That package has already been downloaded, so its one-time link cannot be opened again.', 409);
}

// ---------------------------------------------------------------------------
// The watch-folder side.
// ---------------------------------------------------------------------------

export type PackageRoute = 'import' | 'retain' | 'unreadable';

/**
 * How the watcher should handle a file it recognised.
 *
 * 'settled' is not a routing decision about contents — it means this package is
 * already finished with, so the file is filed away untouched rather than imported
 * again or mistaken for a corrupt export.
 */
export type ClaimRoute = 'import' | 'retain' | 'settled' | 'failed';

/**
 * How to handle an archive, decided by what is actually in it.
 *
 * `selectConversationEntries` is the same anchored matcher the upload path uses,
 * so "contains conversations" means exactly what it means everywhere else in
 * DAMC — including that `shared_conversations.json` does not count.
 */
export function routeByEntries(entryNames: string[], entryCount: number): PackageRoute {
  // Zero entries out of something that looked like a ZIP means the bytes are
  // incomplete, not that the archive holds something unparseable. A half-finished
  // browser download lands here, and it must not be recorded as retained.
  if (entryCount === 0) return 'unreadable';
  return selectConversationEntries(entryNames).names.length ? 'import' : 'retain';
}

export interface ClaimedPackage {
  package: ExportPackage;
  /**
   * Never 'unreadable': an archive nothing could be read from is failed at claim
   * time and reported as no claim at all, so a caller holding a ClaimedPackage
   * always has a real branch to take.
   */
  route: ClaimRoute;
  entryNames: string[];
  entryCount: number;
}

/**
 * Does this arriving file belong to a waiting package, and what should happen to it?
 *
 * Returns null for anything unrelated, so the watcher's existing behaviour for an
 * ordinary dropped export is untouched.
 */
export async function claimWatchedFile(userId: string, filename: string, filePath: string): Promise<ClaimedPackage | null> {
  const key = normalizeDownloadFilename(filename);
  const claimed = await claimPackageForFile(userId, key);
  if (!claimed) {
    // Not waiting for this file — but it may be one DAMC has already dealt with.
    // Saying so is what keeps a second arrival out of failed/.
    const settled = await findSettledPackage(userId, key);
    return settled ? { package: settled, route: 'settled', entryNames: [], entryCount: 0 } : null;
  }

  let entryNames: string[] = [];
  let entryCount = 0;
  try {
    const inspection = await inspectArchiveEntries(filePath, ROUTING_ENTRY_LIMIT);
    entryNames = inspection.entries.map(entry => entry.name);
    entryCount = inspection.entryCount;
  } catch (error) {
    // An unreadable archive is a real outcome, not an absent one: the package is
    // claimed, so it has to be told what happened rather than left 'importing'.
    //
    // And the claim is still returned, with route 'failed'. Returning null here sent
    // the watcher on to the ordinary dropped-file path, which read the same broken
    // archive a second time and filed it in failed/ as "INVALID_JSON" under its bare
    // name — a misreport, and one that can collide with another session's file.
    await failPackage(claimed, error instanceof AppError ? error.code : 'ARCHIVE_UNREADABLE',
      error instanceof Error ? error.message : 'The archive could not be read.');
    return { package: claimed, route: 'failed', entryNames: [], entryCount: 0 };
  }

  const route = routeByEntries(entryNames, entryCount);
  if (route === 'unreadable') {
    await failPackage(claimed, 'ARCHIVE_UNREADABLE',
      'No entries could be read from this archive, so the download is incomplete. Download this package again.');
    return { package: claimed, route: 'failed', entryNames, entryCount };
  }
  return { package: claimed, route, entryNames, entryCount };
}

function firstNumber(stats: Record<string, unknown>, ...keys: string[]): number {
  for (const key of keys) {
    const value = stats[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return 0;
}

/**
 * A conversations archive finished importing. Records what it produced.
 *
 * The importer's counters are normalised to one shape before they are stored,
 * rather than kept as whatever the runner happened to return. That is not tidying:
 * the streaming importer calls its conversation count `conversationsDetected`, so
 * reading `stats.conversations` off the raw result silently produced a session
 * total of zero next to a package that had plainly imported three conversations.
 * One shape on the row means the aggregate and the UI cannot drift from it.
 */
export async function completeImportedPackage(
  claimed: ClaimedPackage,
  bytes: number,
  importJobId: string | null,
  stats: Record<string, unknown>
): Promise<void> {
  await updatePackage(claimed.package.id, {
    status: 'imported',
    bytes,
    entryCount: claimed.entryCount,
    entryNames: claimed.entryNames.slice(0, RECORDED_ENTRY_LIMIT),
    importJobId,
    stats: {
      conversations: firstNumber(stats, 'conversationsDetected', 'conversations'),
      messages: firstNumber(stats, 'messages'),
      imported: firstNumber(stats, 'imported'),
      deduplicated: firstNumber(stats, 'deduplicated'),
      memoriesCreated: firstNumber(stats, 'memoriesCreated'),
      superseded: firstNumber(stats, 'superseded'),
      decisionCount: firstNumber(stats, 'decisionCount'),
      taskCount: firstNumber(stats, 'taskCount')
    },
    finished: true
  });
  await settleSession(claimed.package.userId, claimed.package.sessionJobId);
}

/**
 * A category DAMC has no parser for. The archive is moved out of the watch folder
 * into the job's own directory and its real structure recorded.
 *
 * Keeping it is the point: the link that produced it works once, so discarding it
 * for want of a parser would destroy data the user cannot get back.
 */
export async function retainPackage(claimed: ClaimedPackage, filePath: string): Promise<void> {
  const retained = await retainArchive(claimed.package.sessionJobId, claimed.package.filename, filePath);
  await updatePackage(claimed.package.id, {
    status: 'retained',
    bytes: retained.bytes,
    entryCount: retained.entryCount,
    entryNames: retained.entries.map(entry => entry.name).slice(0, RECORDED_ENTRY_LIMIT),
    stats: { retainedPath: retained.path },
    finished: true
  });
  await settleSession(claimed.package.userId, claimed.package.sessionJobId);
}

export async function failPackage(claimed: ClaimedPackage | ExportPackage, code: string, message: string): Promise<void> {
  const pkg = 'package' in claimed ? claimed.package : claimed;
  await updatePackage(pkg.id, { status: 'failed', errorCode: code, errorMessage: message, finished: true });
  await settleSession(pkg.userId, pkg.sessionJobId);
}

/**
 * Recover a package whose archive was retained but whose row never recorded it.
 *
 * `retainArchive` renames the file out of the watch folder and then writes the row.
 * A process death between those two steps leaves the archive safely on disk and the
 * package saying `opened` — so the session waits for ever for a download DAMC
 * already has, and tells the user to fetch a link that is spent.
 *
 * Called at boot, after resetInterruptedPackages. Looks only at what is on disk, and
 * only for packages that are still pending.
 */
export async function reconcileRetainedPackages(): Promise<number> {
  const packages = await listPendingPackages();
  const touched = new Set<string>();
  let recovered = 0;
  for (const pkg of packages) {
    const target = path.join(retainedArchiveDir(pkg.sessionJobId), path.basename(pkg.filename).replace(/[^A-Za-z0-9._-]/g, '_'));
    const stat = await fs.stat(target).catch(() => null);
    if (!stat?.isFile() || stat.size === 0) continue;
    const inspection = await inspectArchiveEntries(target, ROUTING_ENTRY_LIMIT).catch(() => null);
    await updatePackage(pkg.id, {
      status: 'retained',
      bytes: stat.size,
      entryCount: inspection?.entryCount ?? null,
      entryNames: inspection ? inspection.entries.map(e => e.name).slice(0, RECORDED_ENTRY_LIMIT) : null,
      stats: { retainedPath: target, recoveredAtBoot: true },
      finished: true
    });
    recovered++;
    touched.add(`${pkg.userId}:${pkg.sessionJobId}`);
  }
  for (const key of touched) {
    const [userId, jobId] = key.split(':');
    await settleSession(userId!, jobId!).catch(() => { /* advisory at boot */ });
  }
  return recovered;
}

// ---------------------------------------------------------------------------
// Settling.
// ---------------------------------------------------------------------------

function numberOf(stats: Record<string, unknown> | null, key: string): number {
  const value = stats?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function summarize(jobId: string, packages: ExportPackage[]): SessionSummary {
  const live = packages.filter(p => p.status !== 'superseded');
  const pending = live.filter(p => (PENDING_STATUSES as string[]).includes(p.status));
  const delivered = live.filter(p => (DELIVERED_STATUSES as string[]).includes(p.status));
  const failed = live.filter(p => p.status === 'failed');
  const settled = live.filter(p => p.status === 'imported' || p.status === 'retained');

  const byCategory = new Map<string, SessionSummaryCategory>();
  let conversations = 0, messages = 0, imported = 0, deduplicated = 0, memoriesCreated = 0;
  let decisionCount = 0, taskCount = 0, retainedArchives = 0;

  for (const pkg of live) {
    const row = byCategory.get(pkg.category) ?? {
      category: pkg.category, disposition: pkg.disposition, status: pkg.status,
      conversations: null, messages: null, memoriesCreated: null, kept: 0, entries: null
    };
    // The worst status in a category wins, so a category with one failed part is
    // not reported as finished.
    if (pkg.status === 'failed' || row.status === 'failed') row.status = 'failed';
    else if ((PENDING_STATUSES as string[]).includes(pkg.status)) row.status = pkg.status;

    if (pkg.status === 'imported') {
      const c = numberOf(pkg.stats, 'conversations');
      const m = numberOf(pkg.stats, 'messages');
      const mem = numberOf(pkg.stats, 'memoriesCreated');
      conversations += c; messages += m; memoriesCreated += mem;
      imported += numberOf(pkg.stats, 'imported');
      deduplicated += numberOf(pkg.stats, 'deduplicated');
      decisionCount += numberOf(pkg.stats, 'decisionCount');
      taskCount += numberOf(pkg.stats, 'taskCount');
      row.conversations = (row.conversations ?? 0) + c;
      row.messages = (row.messages ?? 0) + m;
      row.memoriesCreated = (row.memoriesCreated ?? 0) + mem;
    }
    if (pkg.status === 'retained') {
      retainedArchives++;
      row.kept++;
      row.entries = (row.entries ?? 0) + (pkg.entryCount ?? 0);
    }
    byCategory.set(pkg.category, row);
  }

  // A session waits as long as anything is pending — that is the whole point of
  // this flow, and it must not look like a failure while the user is downloading.
  //
  // A session whose every package was superseded is its own outcome, not a failure:
  // nothing went wrong, a newer export simply replaced it. Deriving the status from
  // the non-superseded rows alone reported it as "no package could be imported",
  // which is a lie about work the user never asked to finish.
  const status: SessionSummary['status'] = live.length === 0
    ? 'superseded'
    : pending.length ? 'awaiting_download'
      : settled.length === 0 ? 'failed'
        : failed.length ? 'partial' : 'completed';

  return {
    jobId, status, mode: 'manifest', delivery: 'browser',
    totalFiles: live.length,
    delivered: delivered.length,
    settled: settled.length,
    pending: pending.length,
    conversations, messages, imported, deduplicated, memoriesCreated,
    decisionCount, taskCount, retainedArchives,
    byCategory: [...byCategory.values()],
    packages: live
  };
}

/**
 * Recompute the session and write it onto the job row.
 *
 * `stats` is merged, never replaced, so anything else on the column survives. The
 * job's own status follows the session: 'awaiting_download' while a human still
 * has work to do, a terminal status once every package is accounted for.
 */
export async function settleSession(userId: string, jobId: string): Promise<SessionSummary> {
  const packages = await listPackages(userId, jobId);
  const summary = summarize(jobId, packages);
  const { packages: _packages, ...persisted } = summary;

  if (summary.status === 'superseded') {
    await query(
      `UPDATE sync_jobs SET status='superseded',finished_at=now(),
              error_message='Replaced by a newer Claude export.',
              stats=COALESCE(stats,'{}'::jsonb)||$1::jsonb WHERE id=$2`,
      [JSON.stringify(persisted), jobId]
    );
    return summary;
  }
  if (summary.status === 'awaiting_download') {
    await query(
      `UPDATE sync_jobs SET status='awaiting_download',finished_at=NULL,error_message=NULL,
              stats=COALESCE(stats,'{}'::jsonb)||$1::jsonb WHERE id=$2`,
      [JSON.stringify(persisted), jobId]
    );
    return summary;
  }
  const failedPackages = packages.filter(p => p.status === 'failed');
  const errorMessage = failedPackages.length
    ? `${failedPackages.length}/${summary.totalFiles} package(s) could not be imported: ${failedPackages.map(p => `${p.category} (${p.errorCode ?? 'unknown'})`).join(', ')}`
    : null;
  await query(
    `UPDATE sync_jobs SET status=$1,finished_at=now(),stats=COALESCE(stats,'{}'::jsonb)||$2::jsonb,error_message=$3 WHERE id=$4`,
    [summary.status, JSON.stringify(persisted), errorMessage, jobId]
  );
  return summary;
}
