// What an import did, as data rather than as markup.
//
// Split out of pages/import.js so the decisions are testable and so the page has
// one shape to render. Two things produced an "import happened" state and they
// used to render differently: the response from the import call, and — after a
// page reload discarded that — a sync_jobs row. They normalise to the same shape
// here, so a restored banner is identical to a live one apart from its note.
//
// Nothing in this module touches the DOM or i18n; it returns keys and numbers for
// the page to render.

/** Job statuses that describe a finished attempt worth showing a banner for. */
export const TERMINAL_STATUSES = ['completed', 'partial', 'failed'];

/**
 * Normalise the import endpoint's response.
 *
 * `preview` supplies the message count when the response has none: the import
 * response gained `messages` only recently, and a server that predates it should
 * still fill the banner rather than showing a gap.
 *
 * `finishedAt` is passed in rather than read from the clock here: the import
 * response carries no completion time (the job row does), and keeping the clock
 * out of this module keeps every function in it pure and testable.
 */
export function outcomeFromResult(result, { provider, preview, finishedAt } = {}) {
  if (!result) return null;
  return {
    status: result.status ?? 'completed',
    provider: result.provider ?? provider ?? null,
    fileName: result.fileName ?? null,
    fileBytes: result.fileBytes ?? null,
    detected: pick(result.conversationsDetected, result.conversationsParsed),
    messages: pick(result.messages, preview?.messages),
    imported: result.imported ?? 0,
    deduplicated: result.deduplicated ?? 0,
    memoriesCreated: result.memoriesCreated ?? 0,
    superseded: result.superseded ?? 0,
    decisions: pick(result.decisionCount),
    tasks: pick(result.taskCount),
    shardCount: pick(result.shardCount),
    jobId: result.jobId ?? null,
    finishedAt: result.finishedAt ?? finishedAt ?? null,
    failed: (result.errors ?? []).length,
    errors: result.errors ?? [],
    errorMessage: null,
    restored: false
  };
}

/**
 * Rebuild the same shape from a sync_jobs row, so a completed import survives a
 * page reload. This is the only reason `fileBytes` and `messages` are recorded in
 * the job's stats — nothing in the import pipeline reads them.
 */
export function outcomeFromJob(job) {
  if (!job) return null;
  const stats = job.stats ?? {};
  return {
    status: job.status,
    provider: job.connector ?? null,
    fileName: stats.fileName ?? null,
    fileBytes: pick(stats.fileBytes),
    detected: pick(stats.conversationsDetected),
    messages: pick(stats.messages),
    imported: stats.imported ?? 0,
    deduplicated: stats.deduplicated ?? 0,
    memoriesCreated: stats.memoriesCreated ?? 0,
    superseded: stats.superseded ?? 0,
    decisions: pick(stats.decisionCount),
    tasks: pick(stats.taskCount),
    shardCount: pick(stats.shardCount),
    jobId: job.id ?? null,
    finishedAt: job.finishedAt ?? job.startedAt ?? null,
    failed: (stats.errors ?? []).length,
    errors: stats.errors ?? [],
    errorMessage: job.errorMessage ?? null,
    restored: true
  };
}

/** Newest finished import job, for restoring the banner after a reload. */
export function lastFinishedJob(jobs) {
  return (jobs ?? []).find(job => TERMINAL_STATUSES.includes(job?.status)) ?? null;
}

/**
 * Which banner to show.
 *
 * Four states, because they are four different answers and the page previously
 * rendered them identically — and indistinguishably from a preview:
 *
 *   done       something new was stored
 *   confirmed  the import ran and there was nothing new (a re-run). Still a
 *              success: "0 imported" on its own reads like a failure, which is
 *              exactly the confusion this replaces.
 *   partial    some conversations landed, some could not be read
 *   failed     nothing landed
 */
export function bannerState(outcome) {
  if (!outcome) return null;
  const imported = outcome.imported ?? 0;
  const deduplicated = outcome.deduplicated ?? 0;

  if (outcome.status === 'failed') {
    return { kind: 'failed', tone: 'bad', mark: 'cross', titleKey: 'import.failedTitle' };
  }
  if (outcome.status === 'partial') {
    return {
      kind: 'partial', tone: 'warn', mark: 'warn', titleKey: 'import.partialTitle',
      summaryKey: 'import.partialSummary',
      summaryParams: { imported, detected: outcome.detected ?? 0, failed: outcome.failed ?? 0 }
    };
  }
  if (imported === 0 && deduplicated > 0) {
    return {
      kind: 'confirmed', tone: 'good', mark: 'check', titleKey: 'import.doneConfirmedTitle',
      summaryKey: 'import.confirmedSummary', summaryParams: { deduplicated }
    };
  }
  return {
    kind: 'done', tone: 'good', mark: 'check', titleKey: 'import.doneTitle',
    summaryKey: 'import.doneSummary',
    summaryParams: { imported, detected: outcome.detected ?? 0, memories: outcome.memoriesCreated ?? 0 }
  };
}

/**
 * The i18n key for what the user should do about a failure.
 *
 * "Internal server error" is not actionable, so every recognised condition names
 * a next step instead of echoing the server's sentence alone.
 */
export function errorActionKey(error) {
  const code = error?.code ?? '';
  const status = error?.status ?? 0;
  if (status === 413 || code === 'FILE_TOO_LARGE' || code === 'FST_REQ_FILE_TOO_LARGE') return 'import.errorActionTooLarge';
  // A manifest is refused by the normal import path on purpose: importing it
  // spends single-use links, which must be a deliberate choice.
  if (code === 'MANIFEST_DETECTED') return 'import.errorActionManifest';
  if (code === 'DOWNLOAD_BLOCKED_BY_CHALLENGE') return 'import.errorActionChallenge';
  if (code === 'CONVERSATIONS_JSON_MISSING') return 'import.errorActionMissing';
  if (code === 'ARCHIVE_UNREADABLE' || code === 'EXPORT_JSON_INVALID' || code === 'ARCHIVE_ENTRY_UNREADABLE') return 'import.errorActionCorrupt';
  if (code === 'INTERNAL_ERROR' || status >= 500) return 'import.errorActionServer';
  return 'import.errorActionRetry';
}

/**
 * Percentage complete, or null when there is no honest denominator.
 *
 * The conversation total is unknown until the export has been read to the end, so
 * a percentage needs a source: the preview's count when one was taken (the normal
 * flow, since choosing a file previews it), otherwise shard completion. With
 * neither, this returns null and the caller shows an indeterminate bar rather
 * than inventing a number. Capped at 99 while running — 100 is reserved for
 * actually finished.
 */
export function progressPercent(progress, previewConversations) {
  if (!progress) return null;
  if (previewConversations > 0) {
    return Math.max(0, Math.min(99, Math.round((progress.processed / previewConversations) * 100)));
  }
  if ((progress.shardsTotal ?? 1) > 1) {
    return Math.max(0, Math.min(99, Math.round((progress.shardsProcessed / progress.shardsTotal) * 100)));
  }
  return null;
}

/**
 * What a Claude manifest job is doing, as data.
 *
 * A manifest job is N downloads rather than one file, so its progress has a
 * denominator the file path never has: packages finished out of packages listed.
 * That makes an honest percentage available from the first byte, which is why
 * this does not go through progressPercent.
 */
export function manifestProgress(stats, progress) {
  if (!stats && !progress) return null;
  const total = stats?.totalFiles ?? progress?.totalFiles ?? 0;
  const downloaded = stats?.filesDownloaded ?? progress?.filesDownloaded ?? 0;
  const imported = stats?.filesImported ?? progress?.filesImported ?? 0;
  // Packages DAMC actually has. Deliberately *not* "packages attempted": a run
  // where every download was blocked has attempted all five and obtained none,
  // and reporting that as 100% complete would be the single most misleading thing
  // this card could say. An in-flight package is not counted yet, the same
  // convention shard progress uses.
  const obtained = (stats?.files ?? []).filter(f => f.status === 'imported' || f.status === 'retained').length;
  const done = stats?.files?.length ? obtained : downloaded;
  return {
    total,
    downloaded,
    imported,
    done,
    category: stats?.currentCategory ?? progress?.currentCategory ?? null,
    percent: total > 0 ? Math.max(0, Math.min(100, Math.round((done / total) * 100))) : null,
    files: stats?.files ?? [],
    blockedByChallenge: Boolean(stats?.blockedByChallenge)
  };
}

/**
 * Every state a server-side download attempt can report, and its label.
 *
 * One object, exported, so the i18n test iterates the real set. The lookup falls
 * back rather than throwing — an unknown state must still render — which is
 * precisely why the list cannot be restated in the test: a new state with no label
 * would display as "waiting" for ever with a green suite.
 */
export const MANIFEST_FILE_LABEL_KEYS = {
  queued: 'claude.fileQueued',
  downloading: 'claude.fileDownloading',
  importing: 'claude.fileImporting',
  imported: 'claude.fileImported',
  retained: 'claude.fileRetained',
  already_used: 'claude.fileAlreadyUsed',
  blocked: 'claude.fileBlocked',
  skipped: 'claude.fileSkipped',
  failed: 'claude.fileFailed'
};

export const MANIFEST_FILE_STATUSES = Object.keys(MANIFEST_FILE_LABEL_KEYS);

/** i18n key for a per-file state. Unknown states fall back to "waiting". */
export function manifestFileLabelKey(status) {
  return MANIFEST_FILE_LABEL_KEYS[status] ?? 'claude.fileQueued';
}

/** Badge tone for a per-package state, so the table reads at a glance. */
export function manifestFileTone(status) {
  if (status === 'imported' || status === 'retained') return 'good';
  if (status === 'failed' || status === 'blocked') return 'bad';
  if (status === 'already_used' || status === 'skipped') return 'warn';
  return 'muted';
}

/**
 * Newest server-download manifest job, for restoring its per-file table.
 *
 * `delivery: 'browser'` is excluded deliberately. A browser-download session is
 * also a manifest job, but its per-package detail lives in the session and it has
 * no `files` array — so matching it here rendered an empty table claiming
 * "0 of 5" beside a session that had just completed.
 */
export function lastManifestJob(jobs) {
  return (jobs ?? []).find(job => job?.stats?.mode === 'manifest' && job?.stats?.delivery !== 'browser') ?? null;
}

/**
 * Is the conversation-counter banner worth showing for this job?
 *
 * A manifest job that never got as far as importing anything would render a table
 * of zeros next to the package card that already explains exactly what happened —
 * two answers to one question, one of them useless. A manifest job that *did*
 * import conversations keeps its counters, because those are the numbers the user
 * came for.
 */
export function showsFileOutcome(job, session) {
  if (!job) return false;
  // A settled session already reports this export package by package and category
  // by category, so the watcher's own per-package import job is the same work seen
  // from the other side and showing both puts two answers to one question on screen.
  //
  // Only that job, though. Checking the session alone also hid the banner for an
  // ordinary ChatGPT upload the user had just run, which has nothing to do with the
  // session — so the test is whether this job IS one of the session's imports.
  if (session && session.status !== 'awaiting_download' && belongsToSession(job, session)) return false;
  const stats = job.stats ?? {};
  if (stats.mode !== 'manifest') return true;
  return (stats.imported ?? 0) + (stats.deduplicated ?? 0) > 0;
}

/** Is this sync job the session itself, or one of the imports it produced? */
export function belongsToSession(job, session) {
  if (!job || !session) return false;
  if (job.id && job.id === session.jobId) return true;
  return (session.packages ?? []).some(pkg => pkg.importJobId && pkg.importJobId === job.id);
}

/** `undefined`/`null` collapse to null so the page can omit a tile rather than print 0. */
function pick(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null) return value;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Claude export packages downloaded by the user's own browser.
//
// A session is five files the user fetches themselves, so the page has to answer
// a different question from "how did the import go": which package is the user
// supposed to act on right now, and what has happened to the others. These are
// the decisions behind that, kept out of the markup so they can be pinned.
// ---------------------------------------------------------------------------

/**
 * Every per-package state, in lifecycle order.
 *
 * Exported so the i18n test can iterate the real list instead of restating it.
 * A hand-copied array is exactly how a new state ends up rendering as "waiting"
 * for ever with a green suite: the label lookups below fall back rather than
 * throw, on purpose, because an unknown state must still render.
 */
export const PACKAGE_STATUSES = [
  'awaiting_download', 'opened', 'detected', 'importing', 'imported', 'retained', 'failed', 'superseded'
];

const PACKAGE_LABEL_KEYS = {
  awaiting_download: 'claude.pkgAwaiting',
  opened: 'claude.pkgOpened',
  detected: 'claude.pkgDetected',
  importing: 'claude.pkgImporting',
  imported: 'claude.pkgImported',
  retained: 'claude.pkgRetained',
  failed: 'claude.pkgFailed',
  superseded: 'claude.pkgSuperseded'
};

/** i18n key for a package's state. The one the user reads in the list. */
export function packageStatusLabelKey(status) {
  return PACKAGE_LABEL_KEYS[status] ?? 'claude.pkgAwaiting';
}

export function packageStatusTone(status) {
  if (status === 'imported' || status === 'retained') return 'good';
  if (status === 'failed') return 'bad';
  if (status === 'detected' || status === 'importing') return 'info';
  if (status === 'superseded') return 'muted';
  return 'muted';
}

/**
 * The i18n key for why a package failed, or null to fall back to the server's own
 * sentence.
 *
 * The recognised codes get a localised message with the next step in it, because the
 * server's English sentence under a Korean heading is both untranslated and less
 * actionable. An unrecognised code still shows whatever the server said rather than
 * swallowing it.
 */
export function packageErrorKey(code) {
  return {
    ARCHIVE_UNREADABLE: 'claude.pkgErrUnreadable',
    IMPORT_ERROR: 'claude.pkgErrImport',
    RETAIN_ERROR: 'claude.pkgErrRetain'
  }[code] ?? null;
}

/** States in which the file has arrived, so its one-time link must never re-open. */
export const DELIVERED_PACKAGE_STATUSES = ['detected', 'importing', 'imported', 'retained'];

export function packageDelivered(pkg) {
  return DELIVERED_PACKAGE_STATUSES.includes(pkg?.status);
}

/**
 * Which package the user should download next.
 *
 * One at a time, in order. Five download buttons at once invites five clicks on
 * single-use links, five simultaneous multi-gigabyte writes into the folder the
 * watcher is sampling for stability, and no way to tell which download failed.
 * The gate opens on `opened` rather than on arrival, so a download that never
 * starts cannot deadlock the rest of the session.
 */
export function nextPackage(packages) {
  return (packages ?? []).find(p => p.status === 'awaiting_download') ?? null;
}

/**
 * Should this row offer a "download in your browser" button?
 *
 * Three conditions, all of them real:
 *   the file has not already arrived — a spent link cannot produce another copy;
 *   the page still holds this package's URL — it lives in browser memory only, so
 *   a reload loses it and the manifest has to be re-selected;
 *   it is this package's turn, or it was already opened and may need re-opening.
 */
export function packageAction(pkg, packages, hasUrl) {
  if (!pkg) return 'none';
  if (packageDelivered(pkg)) return 'none';
  if (pkg.status === 'superseded') return 'none';
  if (!hasUrl) return 'needs-manifest';
  if (pkg.status === 'failed') return 'redownload';
  if (pkg.status === 'opened') return 'reopen';
  return nextPackage(packages)?.id === pkg.id ? 'download' : 'queued';
}

/**
 * How far through the session we are.
 *
 * The denominator is honest from the first moment — packages listed — which is why
 * this does not go through progressPercent. `done` counts only packages DAMC
 * actually has, so a session where every download failed reads 0%, not 100%.
 */
export function sessionProgress(session) {
  if (!session) return null;
  const packages = session.packages ?? [];
  const total = session.totalFiles ?? packages.length;
  const done = packages.filter(p => p.status === 'imported' || p.status === 'retained').length;
  const delivered = packages.filter(p => packageDelivered(p)).length;
  return {
    total,
    done,
    delivered,
    pending: packages.filter(p => ['awaiting_download', 'opened', 'detected', 'importing'].includes(p.status)).length,
    failed: packages.filter(p => p.status === 'failed').length,
    percent: total > 0 ? Math.max(0, Math.min(100, Math.round((done / total) * 100))) : null
  };
}

/**
 * The session's headline.
 *
 * A waiting session is not a pending import — it is the user's turn, and the
 * banner has to say so rather than showing a spinner that implies DAMC is busy.
 */
export function sessionBanner(session) {
  if (!session) return null;
  if (session.status === 'awaiting_download') {
    const p = sessionProgress(session);
    return {
      kind: 'waiting', tone: 'info', mark: 'arrow', titleKey: 'claude.sessionWaitingTitle',
      summaryKey: 'claude.sessionWaitingSummary',
      summaryParams: { done: String(p.done), total: String(p.total) }
    };
  }
  if (session.status === 'failed') {
    return { kind: 'failed', tone: 'bad', mark: 'cross', titleKey: 'claude.sessionFailedTitle', summaryKey: 'claude.sessionFailedSummary' };
  }
  if (session.status === 'partial') {
    const p = sessionProgress(session);
    return {
      kind: 'partial', tone: 'warn', mark: 'warn', titleKey: 'claude.sessionPartialTitle',
      summaryKey: 'claude.sessionPartialSummary',
      summaryParams: { done: String(p.done), total: String(p.total), failed: String(p.failed) }
    };
  }
  return {
    kind: 'done', tone: 'good', mark: 'check', titleKey: 'claude.sessionDoneTitle',
    summaryKey: 'claude.sessionDoneSummary',
    summaryParams: {
      conversations: String(session.conversations ?? 0),
      memories: String(session.memoriesCreated ?? 0)
    }
  };
}

/**
 * Does this manifest describe the session already on screen?
 *
 * If it does, re-selecting the file re-attaches the download URLs the page lost on
 * reload instead of starting a second session — which would supersede the first
 * one's pending packages and strand the files the user had already downloaded.
 */
export function manifestMatchesSession(manifestFilenames, session) {
  if (!session || !manifestFilenames?.length) return false;
  // Only a session still waiting for downloads. Every Claude export uses the same
  // five filenames, so matching a finished session made the NEXT export look like a
  // reconnect to the last one: the start button vanished and there was no way to
  // import it at all.
  if (session.status !== 'awaiting_download') return false;
  const a = [...manifestFilenames].map(normalizePackageName).sort();
  const b = (session.packages ?? []).map(p => normalizePackageName(p.filename)).sort();
  return a.length === b.length && a.every((name, i) => name === b[i]);
}

/**
 * The name a download is matched under, mirroring the server's rule.
 *
 * A browser writes `conversations-000 (1).zip` when the folder already holds that
 * name, so exactly that one suffix is dropped. Kept in step with
 * normalizeDownloadFilename in claude-manifest-service.ts — if these two disagree,
 * the page offers a button for a package the server will never match.
 */
export function normalizePackageName(name) {
  const base = String(name ?? '').replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? '';
  return base.replace(/\s*\(\d+\)(?=\.[^.]*$|$)/, '').trim().toLowerCase();
}
