/**
 * What the import page tells the user after an import.
 *
 * The problem these cover: a successful full import and a mere file preview
 * rendered the same way, so "it worked" was not visible — and a re-run that
 * deduplicated everything reported "0 imported", which reads like a failure. The
 * decisions live in web/import-outcome.js precisely so they can be pinned here
 * instead of being buried in markup.
 */
import { describe, expect, it } from 'vitest';
import {
  outcomeFromResult, outcomeFromJob, lastFinishedJob, bannerState, errorActionKey, progressPercent,
  manifestProgress, manifestFileLabelKey, manifestFileTone, lastManifestJob, showsFileOutcome,
  MANIFEST_FILE_STATUSES, PACKAGE_STATUSES, packageStatusLabelKey, packageStatusTone,
  packageAction, sessionProgress, sessionBanner, manifestMatchesSession, normalizePackageName,
  belongsToSession, packageErrorKey
} from '../web/import-outcome.js';
import { DICTIONARIES } from '../web/i18n.js';

/** A realistic response from POST /v1/import/:provider/file. */
const importResult = (overrides: Record<string, unknown> = {}) => ({
  jobId: 'job-1', provider: 'chatgpt', status: 'completed',
  imported: 236, deduplicated: 0, memoriesCreated: 4053, superseded: 17,
  decisionCount: 968, taskCount: 1050, conversationsDetected: 236, messages: 5296,
  shardCount: 3, shardNames: ['conversations-000.json', 'conversations-001.json', 'conversations-002.json'],
  errors: [], fileName: 'export.zip', fileBytes: 2004038565, container: 'zip', layout: 'sharded',
  conversationsParsed: 236,
  ...overrides
});

/** A realistic row from GET /v1/sync/jobs. */
const job = (overrides: Record<string, unknown> = {}, stats: Record<string, unknown> = {}) => ({
  id: 'job-1', connector: 'chatgpt', status: 'completed',
  startedAt: '2026-09-13T03:00:00.000Z', finishedAt: '2026-09-13T03:06:11.000Z',
  errorMessage: null,
  stats: {
    source: 'web', fileName: 'export.zip', fileBytes: 2004038565,
    conversationsDetected: 236, messages: 5296, imported: 236, deduplicated: 0,
    memoriesCreated: 4053, superseded: 17, decisionCount: 968, taskCount: 1050,
    shardCount: 3, errors: [], ...stats
  },
  ...overrides
});

describe('preview only', () => {
  it('produces no outcome, so no completion banner is shown', () => {
    expect(outcomeFromResult(null)).toBeNull();
    expect(bannerState(null)).toBeNull();
    expect(outcomeFromResult(undefined)).toBeNull();
  });
});

describe('full import completed', () => {
  it('normalises everything the banner has to show', () => {
    const o = outcomeFromResult(importResult())!;
    expect(o).toMatchObject({
      status: 'completed', provider: 'chatgpt', fileName: 'export.zip', fileBytes: 2004038565,
      detected: 236, messages: 5296, imported: 236, deduplicated: 0,
      memoriesCreated: 4053, superseded: 17, decisions: 968, tasks: 1050, shardCount: 3,
      jobId: 'job-1', restored: false
    });
  });

  it('reports a success banner naming what was stored', () => {
    const banner = bannerState(outcomeFromResult(importResult()))!;
    expect(banner.kind).toBe('done');
    expect(banner.tone).toBe('good');
    expect(banner.mark).toBe('check');
    expect(banner.titleKey).toBe('import.doneTitle');
    expect(banner.summaryParams).toEqual({ imported: 236, detected: 236, memories: 4053 });
  });

  it('takes the completion time from the caller, since the response has none', () => {
    const o = outcomeFromResult(importResult(), { finishedAt: '2026-09-13T04:00:00.000Z' })!;
    expect(o.finishedAt).toBe('2026-09-13T04:00:00.000Z');
    // A response that does carry one wins over the caller's stamp.
    const withOwn = outcomeFromResult(importResult({ finishedAt: '2026-01-01T00:00:00.000Z' }), { finishedAt: '2026-09-13T04:00:00.000Z' })!;
    expect(withOwn.finishedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('borrows the message count from the preview when the response has none', () => {
    const result = importResult();
    delete (result as any).messages;
    const o = outcomeFromResult(result, { preview: { messages: 5296 } })!;
    expect(o.messages).toBe(5296);
  });

  it('omits counts the server did not report, rather than showing a misleading zero', () => {
    const o = outcomeFromResult({ status: 'completed', imported: 3, deduplicated: 0 })!;
    expect(o.messages).toBeNull();
    expect(o.decisions).toBeNull();
    expect(o.tasks).toBeNull();
    expect(o.shardCount).toBeNull();
  });
});

/** Requirement 7: a re-run that stores nothing new is still a success. */
describe('duplicate import', () => {
  it('reads as confirmation, not as an empty result', () => {
    const banner = bannerState(outcomeFromResult(importResult({ imported: 0, deduplicated: 236, memoriesCreated: 0 })))!;
    expect(banner.kind).toBe('confirmed');
    expect(banner.tone).toBe('good');
    expect(banner.mark).toBe('check');
    expect(banner.titleKey).toBe('import.doneConfirmedTitle');
    expect(banner.summaryKey).toBe('import.confirmedSummary');
    expect(banner.summaryParams).toEqual({ deduplicated: 236 });
  });

  it('a genuinely empty export is not dressed up as a confirmation', () => {
    // Nothing imported AND nothing deduplicated: there was no prior data to
    // confirm, so this is the plain done state with honest zeros.
    const banner = bannerState(outcomeFromResult(importResult({ imported: 0, deduplicated: 0, conversationsDetected: 0, memoriesCreated: 0 })))!;
    expect(banner.kind).toBe('done');
    expect(banner.summaryParams).toEqual({ imported: 0, detected: 0, memories: 0 });
  });
});

describe('partial', () => {
  it('warns, and says how many could not be read', () => {
    const o = outcomeFromResult(importResult({
      status: 'partial', imported: 230, conversationsDetected: 236,
      errors: [{ conversation: 'c1', message: 'boom' }, { conversation: 'c2', message: 'boom' }]
    }))!;
    expect(o.failed).toBe(2);
    const banner = bannerState(o)!;
    expect(banner.kind).toBe('partial');
    expect(banner.tone).toBe('warn');
    expect(banner.mark).toBe('warn');
    expect(banner.summaryParams).toEqual({ imported: 230, detected: 236, failed: 2 });
  });
});

describe('failed', () => {
  it('shows the failed banner with the job error rather than a generic line', () => {
    const banner = bannerState(outcomeFromJob(job({ status: 'failed', errorMessage: 'Export JSON contains no conversations array' })))!;
    expect(banner.kind).toBe('failed');
    expect(banner.tone).toBe('bad');
    expect(banner.mark).toBe('cross');
    expect(banner.summaryKey).toBeUndefined(); // the page falls back to errorMessage
  });

  /** Requirement 8: never leave the user with "Internal server error" alone. */
  it('maps each failure to an action the user can take', () => {
    expect(errorActionKey({ status: 413 })).toBe('import.errorActionTooLarge');
    expect(errorActionKey({ code: 'FILE_TOO_LARGE' })).toBe('import.errorActionTooLarge');
    expect(errorActionKey({ code: 'FST_REQ_FILE_TOO_LARGE' })).toBe('import.errorActionTooLarge');
    expect(errorActionKey({ code: 'CONVERSATIONS_JSON_MISSING' })).toBe('import.errorActionMissing');
    expect(errorActionKey({ code: 'ARCHIVE_UNREADABLE' })).toBe('import.errorActionCorrupt');
    expect(errorActionKey({ code: 'EXPORT_JSON_INVALID' })).toBe('import.errorActionCorrupt');
    expect(errorActionKey({ code: 'INTERNAL_ERROR', status: 500 })).toBe('import.errorActionServer');
    expect(errorActionKey({ status: 503 })).toBe('import.errorActionServer');
    expect(errorActionKey({ code: 'SOMETHING_NEW' })).toBe('import.errorActionRetry');
    expect(errorActionKey(null)).toBe('import.errorActionRetry');
  });
});

/** Requirement 9: the banner survives a page reload. */
describe('restored after a refresh', () => {
  it('rebuilds the same shape from a job row', () => {
    const fromJob = outcomeFromJob(job())!;
    expect(fromJob).toMatchObject({
      status: 'completed', provider: 'chatgpt', fileName: 'export.zip', fileBytes: 2004038565,
      detected: 236, messages: 5296, imported: 236, memoriesCreated: 4053,
      decisions: 968, tasks: 1050, shardCount: 3, jobId: 'job-1', restored: true
    });
    expect(fromJob.finishedAt).toBe('2026-09-13T03:06:11.000Z');
  });

  it('renders the same banner as the live result did', () => {
    const live = bannerState(outcomeFromResult(importResult()))!;
    const restored = bannerState(outcomeFromJob(job()))!;
    expect(restored.kind).toBe(live.kind);
    expect(restored.titleKey).toBe(live.titleKey);
    expect(restored.summaryParams).toEqual(live.summaryParams);
  });

  it('is marked restored so the page can say where it came from', () => {
    expect(outcomeFromJob(job())!.restored).toBe(true);
    expect(outcomeFromResult(importResult())!.restored).toBe(false);
  });

  it('restores a deduplicated-only run as a confirmation too', () => {
    const o = outcomeFromJob(job({}, { imported: 0, deduplicated: 236, memoriesCreated: 0 }))!;
    expect(bannerState(o)!.kind).toBe('confirmed');
  });

  it('falls back to startedAt when a job never recorded a finish time', () => {
    expect(outcomeFromJob(job({ finishedAt: null }))!.finishedAt).toBe('2026-09-13T03:00:00.000Z');
  });

  it('picks the newest finished job and ignores ones still running', () => {
    const jobs = [
      { id: 'a', status: 'running' },
      { id: 'b', status: 'completed' },
      { id: 'c', status: 'completed' }
    ];
    expect(lastFinishedJob(jobs)!.id).toBe('b');
    expect(lastFinishedJob([{ id: 'x', status: 'queued' }])).toBeNull();
    expect(lastFinishedJob([])).toBeNull();
    expect(lastFinishedJob(undefined)).toBeNull();
  });

  it('restores partial and failed jobs, not just completed ones', () => {
    expect(lastFinishedJob([{ id: 'p', status: 'partial' }])!.id).toBe('p');
    expect(lastFinishedJob([{ id: 'f', status: 'failed' }])!.id).toBe('f');
  });

  it('survives a job row with no stats at all', () => {
    const o = outcomeFromJob({ id: 'j', connector: 'claude', status: 'completed' })!;
    expect(o.imported).toBe(0);
    expect(o.detected).toBeNull();
    expect(bannerState(o)!.kind).toBe('done');
  });
});

/** Requirements 5 and 6: real progress while running, 100% when done. */
describe('progress percentage', () => {
  it('uses the preview total when one was taken', () => {
    expect(progressPercent({ processed: 118, shardsTotal: 3, shardsProcessed: 1 }, 236)).toBe(50);
  });

  it('falls back to shard completion when no preview total is known', () => {
    expect(progressPercent({ processed: 500, shardsTotal: 4, shardsProcessed: 2 }, 0)).toBe(50);
  });

  it('returns null rather than inventing a number with no denominator', () => {
    expect(progressPercent({ processed: 10, shardsTotal: 1, shardsProcessed: 0 }, 0)).toBeNull();
    expect(progressPercent(null, 236)).toBeNull();
  });

  it('never reports 100 while still running — that is reserved for finished', () => {
    expect(progressPercent({ processed: 236, shardsTotal: 1, shardsProcessed: 0 }, 236)).toBe(99);
    expect(progressPercent({ processed: 999, shardsTotal: 1, shardsProcessed: 0 }, 236)).toBe(99);
    expect(progressPercent({ processed: 0, shardsTotal: 4, shardsProcessed: 4 }, 0)).toBe(99);
  });

  it('stays within 0..99', () => {
    expect(progressPercent({ processed: -5, shardsTotal: 1, shardsProcessed: 0 }, 236)).toBe(0);
  });
});

/** Requirement 11: every key the banner uses exists in both languages. */
describe('i18n coverage for the new states', () => {
  const KEYS = [
    'import.doneTitle', 'import.doneConfirmedTitle', 'import.partialTitle', 'import.failedTitle',
    'import.doneSummary', 'import.confirmedSummary', 'import.partialSummary',
    'import.resultSectionTitle', 'import.previewSectionTitle', 'import.previewSectionHint',
    'import.finishedAt', 'import.statProvider', 'import.statDecisions', 'import.statTasks',
    'import.statMessages', 'import.statShards', 'import.restoredNote',
    'import.progressShard', 'import.progressConversations', 'import.progressPercent', 'import.progressStarting',
    'import.errorAction', 'import.errorActionTooLarge', 'import.errorActionMissing',
    'import.errorActionCorrupt', 'import.errorActionServer', 'import.errorActionRetry'
  ];

  it('has an English and a Korean string for each', () => {
    for (const key of KEYS) {
      expect(DICTIONARIES.en[key], `EN ${key}`).toBeTruthy();
      expect(DICTIONARIES.ko[key], `KO ${key}`).toBeTruthy();
      expect(DICTIONARIES.ko[key], `KO ${key} must be translated`).not.toBe(DICTIONARIES.en[key]);
    }
  });

  it('every key a banner state names actually exists', () => {
    const states = [
      bannerState(outcomeFromResult(importResult())),
      bannerState(outcomeFromResult(importResult({ imported: 0, deduplicated: 5 }))),
      bannerState(outcomeFromResult(importResult({ status: 'partial' }))),
      bannerState(outcomeFromResult(importResult({ status: 'failed' })))
    ];
    for (const state of states) {
      expect(DICTIONARIES.en[state!.titleKey], state!.titleKey).toBeTruthy();
      if (state!.summaryKey) expect(DICTIONARIES.en[state!.summaryKey], state!.summaryKey).toBeTruthy();
    }
  });

  it('every error action key resolves', () => {
    for (const error of [{ status: 413 }, { code: 'CONVERSATIONS_JSON_MISSING' }, { code: 'ARCHIVE_UNREADABLE' }, { code: 'INTERNAL_ERROR' }, {}]) {
      const key = errorActionKey(error);
      expect(DICTIONARIES.en[key], key).toBeTruthy();
      expect(DICTIONARIES.ko[key], key).toBeTruthy();
    }
  });
});

/**
 * A Claude manifest import shows a different thing: not one file's counters but a
 * table of packages, each with its own state. These pin the parts of that the page
 * should not have to work out in markup.
 */
describe('Claude manifest job view', () => {
  const manifestJob = (overrides: Record<string, unknown> = {}) => ({
    id: 'job-m', connector: 'claude', status: 'completed',
    finishedAt: '2026-09-13T02:00:00Z',
    stats: {
      mode: 'manifest', totalFiles: 5, filesDownloaded: 5, filesImported: 1,
      currentCategory: null, blockedByChallenge: false,
      files: [
        { category: 'conversations', filename: 'conversations-000.zip', status: 'imported', bytes: 100, conversations: 12, imported: 12, deduplicated: 0, memoriesCreated: 30, entryNames: ['conversations.json'], entryCount: 1, errorCode: null, errorMessage: null },
        { category: 'memories', filename: 'memories-000.zip', status: 'retained', bytes: 50, conversations: null, imported: null, entryNames: ['memories/index.json'], entryCount: 1, errorCode: null, errorMessage: null },
        { category: 'projects', filename: 'projects-000.zip', status: 'retained', bytes: 50, entryNames: [], entryCount: 0, errorCode: null, errorMessage: null },
        { category: 'design_chats', filename: 'design_chats-000.zip', status: 'retained', bytes: 10, entryNames: [], entryCount: 0, errorCode: null, errorMessage: null },
        { category: 'light_metadata', filename: 'light_metadata-000.zip', status: 'retained', bytes: 10, entryNames: [], entryCount: 0, errorCode: null, errorMessage: null }
      ],
      ...(overrides.stats as object ?? {})
    },
    ...overrides
  });

  it('reports honest progress from the first package', () => {
    // Unlike a single file, a manifest has a denominator immediately: packages
    // listed. So there is never a reason to show an indeterminate bar.
    const p = manifestProgress(manifestJob().stats, null)!;
    expect(p.total).toBe(5);
    expect(p.done).toBe(5);
    expect(p.percent).toBe(100);
    expect(p.imported).toBe(1);
  });

  it('does not count a package still in flight as done', () => {
    const stats = manifestJob().stats;
    stats.files[3]!.status = 'downloading';
    stats.files[4]!.status = 'queued';
    const p = manifestProgress(stats, { totalFiles: 5, filesDownloaded: 3 } as never)!;
    expect(p.done).toBe(3);
    expect(p.percent).toBe(60);
  });

  it('falls back to live progress before any stats exist', () => {
    const p = manifestProgress(null, { totalFiles: 5, filesDownloaded: 2, filesImported: 0, currentCategory: 'conversations' } as never)!;
    expect(p.total).toBe(5);
    expect(p.done).toBe(2);
    expect(p.category).toBe('conversations');
  });

  it('surfaces a bot-protection block as its own condition', () => {
    const job = manifestJob({ status: 'failed' });
    job.stats.blockedByChallenge = true;
    expect(manifestProgress(job.stats, null)!.blockedByChallenge).toBe(true);
  });

  it('never reports 100% for a run that obtained nothing', () => {
    // The regression this pins: counting *attempted* packages made a run where
    // every download was blocked read as "100% complete, 5 of 5" next to a FAILED
    // badge — the most misleading thing this card could say.
    const job = manifestJob({ status: 'failed' });
    job.stats.blockedByChallenge = true;
    job.stats.files[0]!.status = 'blocked';
    for (const file of job.stats.files.slice(1)) file.status = 'skipped';
    const p = manifestProgress(job.stats, null)!;
    expect(p.done).toBe(0);
    expect(p.percent).toBe(0);
  });

  it('does not credit a package that failed after being downloaded', () => {
    const job = manifestJob({ status: 'partial' });
    job.stats.files[0]!.status = 'failed';
    const p = manifestProgress(job.stats, null)!;
    // Four retained, one failed: four fifths, not five.
    expect(p.done).toBe(4);
    expect(p.percent).toBe(80);
  });

  it('labels and tones every package state', () => {
    const states = MANIFEST_FILE_STATUSES;
    for (const status of states) {
      const key = manifestFileLabelKey(status);
      // Every label must actually exist in both dictionaries.
      expect(DICTIONARIES.en[key], `${status} en`).toBeTruthy();
      expect(DICTIONARIES.ko[key], `${status} ko`).toBeTruthy();
    }
    expect(manifestFileTone('imported')).toBe('good');
    expect(manifestFileTone('retained')).toBe('good');
    expect(manifestFileTone('blocked')).toBe('bad');
    expect(manifestFileTone('failed')).toBe('bad');
    expect(manifestFileTone('already_used')).toBe('warn');
    expect(manifestFileTone('downloading')).toBe('muted');
    // An unrecognised state must still render rather than throwing.
    expect(manifestFileLabelKey('something_new')).toBe('claude.fileQueued');
  });

  it('ignores a browser-download session when restoring the server-download table', () => {
    // A session is also mode:'manifest', but its detail lives in the session and it
    // has no files[] — matching it rendered an empty table claiming "0 of 5" next to
    // a session that had just completed.
    const session = { id: 'sess', status: 'completed', stats: { mode: 'manifest', delivery: 'browser', totalFiles: 5 } };
    expect(lastManifestJob([session])).toBeNull();
    expect(lastManifestJob([session, manifestJob()])!.id).toBe('job-m');
  });

  it('finds the newest manifest job to restore after a reload', () => {
    const jobs = [
      { id: 'file-job', status: 'completed', stats: { mode: undefined, imported: 1 } },
      manifestJob()
    ];
    expect(lastManifestJob(jobs)!.id).toBe('job-m');
    // A history with no manifest import restores nothing rather than mislabelling
    // an ordinary upload as one.
    expect(lastManifestJob([{ id: 'x', status: 'completed', stats: {} }])).toBeNull();
    expect(lastManifestJob(undefined)).toBeNull();
  });

  it('names a next step for the two new failure codes', () => {
    expect(errorActionKey({ code: 'MANIFEST_DETECTED', status: 409 })).toBe('import.errorActionManifest');
    expect(errorActionKey({ code: 'DOWNLOAD_BLOCKED_BY_CHALLENGE', status: 502 })).toBe('import.errorActionChallenge');
    for (const key of ['import.errorActionManifest', 'import.errorActionChallenge']) {
      expect(DICTIONARIES.en[key]).toBeTruthy();
      expect(DICTIONARIES.ko[key]).toBeTruthy();
    }
  });
});

describe('which card answers "what happened"', () => {
  const file = { id: 'j', status: 'completed', stats: { imported: 5, deduplicated: 0 } };
  const blockedManifest = { id: 'm', status: 'failed', stats: { mode: 'manifest', imported: 0, deduplicated: 0, totalFiles: 5, files: [] } };
  const importedManifest = { id: 'm2', status: 'completed', stats: { mode: 'manifest', imported: 12, deduplicated: 0, totalFiles: 5, files: [] } };
  const confirmedManifest = { id: 'm3', status: 'completed', stats: { mode: 'manifest', imported: 0, deduplicated: 12, totalFiles: 5, files: [] } };

  it('keeps the counter banner for an ordinary file import', () => {
    expect(showsFileOutcome(file)).toBe(true);
  });

  it('drops it for a manifest job that imported nothing', () => {
    // The package card already says precisely what happened to all five files; a
    // second card of zeros beside it is noise, not information.
    expect(showsFileOutcome(blockedManifest)).toBe(false);
  });

  it('keeps it for a manifest job that did import', () => {
    expect(showsFileOutcome(importedManifest)).toBe(true);
    // A re-run that deduplicated everything still imported nothing new, but the
    // counters are the answer the user wants — 0 new / 12 existing.
    expect(showsFileOutcome(confirmedManifest)).toBe(true);
  });

  it('shows nothing at all when there is no job', () => {
    expect(showsFileOutcome(null)).toBe(false);
  });

  it('defers to a settled session for that session’s own jobs', () => {
    // The watcher creates an ordinary import job per package. Beside a finished
    // session that already reports every category, it is a second answer to one
    // question — and the less informative of the two. Only for *its* jobs, though:
    // suppressing on the session alone also hid an unrelated ChatGPT upload's banner.
    const settled = { jobId: 'sess', status: 'completed', packages: [{ importJobId: 'j' }] };
    expect(showsFileOutcome(file, settled)).toBe(false);
    expect(showsFileOutcome({ id: 'unrelated', status: 'completed', stats: { imported: 2 } }, settled)).toBe(true);
    // While the session is still waiting there is no summary yet, so an ordinary
    // import banner is still the useful thing to show.
    expect(showsFileOutcome(file, { jobId: 'sess', status: 'awaiting_download', packages: [{ importJobId: 'j' }] })).toBe(true);
    expect(showsFileOutcome(file, null)).toBe(true);
  });
});

/**
 * The browser-download session, as the page sees it.
 *
 * The user fetches five files themselves, so the page has to answer a question the
 * upload flow never asks: which package is this person supposed to act on right
 * now. These pin that, and the two rules that keep a single-use link safe.
 */
describe('Claude export package session', () => {
  const pkg = (over: Record<string, unknown> = {}) => ({
    id: 'p1', sequence: 1, category: 'conversations', filename: 'conversations-000.zip',
    status: 'awaiting_download', bytes: null, entryCount: null, entryNames: [],
    stats: null, errorCode: null, errorMessage: null, ...over
  });

  const session = (packages: Array<Record<string, unknown>>, over: Record<string, unknown> = {}) => ({
    jobId: 'job-s', status: 'awaiting_download', mode: 'manifest', delivery: 'browser',
    totalFiles: packages.length, conversations: 0, messages: 0, imported: 0,
    deduplicated: 0, memoriesCreated: 0, retainedArchives: 0, byCategory: [],
    packages, ...over
  });

  const fivePending = () => [
    pkg({ id: 'p1', sequence: 1, filename: 'conversations-000.zip' }),
    pkg({ id: 'p2', sequence: 2, filename: 'memories-000.zip', category: 'memories' }),
    pkg({ id: 'p3', sequence: 3, filename: 'projects-000.zip', category: 'projects' }),
    pkg({ id: 'p4', sequence: 4, filename: 'design_chats-000.zip', category: 'design_chats' }),
    pkg({ id: 'p5', sequence: 5, filename: 'light_metadata-000.zip', category: 'light_metadata' })
  ];

  it('labels and tones every package state, from the real list', () => {
    // Iterating the exported array rather than a copy of it is the point: the label
    // lookup falls back instead of throwing, so a new state with no translation
    // would otherwise read as "download needed" for ever with a green suite.
    for (const status of PACKAGE_STATUSES) {
      const key = packageStatusLabelKey(status);
      expect(DICTIONARIES.en[key], `${status} en`).toBeTruthy();
      expect(DICTIONARIES.ko[key], `${status} ko`).toBeTruthy();
      expect(['good', 'bad', 'warn', 'info', 'muted']).toContain(packageStatusTone(status));
    }
    expect(PACKAGE_STATUSES).toContain('awaiting_download');
    expect(PACKAGE_STATUSES).toContain('superseded');
  });

  it('checks the same for the server-download states, from their real list', () => {
    for (const status of MANIFEST_FILE_STATUSES) {
      expect(DICTIONARIES.en[manifestFileLabelKey(status)], status).toBeTruthy();
      expect(DICTIONARIES.ko[manifestFileLabelKey(status)], status).toBeTruthy();
    }
  });

  it('offers exactly one download button, on the first package still needed', () => {
    const packages = fivePending();
    const actions = packages.map(p => packageAction(p, packages, true));
    // One at a time: five live buttons invites five clicks on single-use links and
    // five concurrent multi-gigabyte writes into the folder being sampled.
    expect(actions).toEqual(['download', 'queued', 'queued', 'queued', 'queued']);
  });

  it('moves the button along as soon as a link is opened, not when the file arrives', () => {
    const packages = fivePending();
    packages[0]!.status = 'opened';
    const actions = packages.map(p => packageAction(p, packages, true));
    // Gating on arrival would deadlock the session on a download that never starts.
    expect(actions[0]).toBe('reopen');
    expect(actions[1]).toBe('download');
  });

  it('never offers a link once its file has arrived', () => {
    for (const status of ['detected', 'importing', 'imported', 'retained']) {
      const packages = [pkg({ status }), pkg({ id: 'p2', sequence: 2, filename: 'memories-000.zip' })];
      expect(packageAction(packages[0]!, packages, true), status).toBe('none');
    }
  });

  it('offers a re-download after a failure', () => {
    const packages = [pkg({ status: 'failed', errorCode: 'ARCHIVE_UNREADABLE' })];
    expect(packageAction(packages[0]!, packages, true)).toBe('redownload');
  });

  it('says the manifest is needed again when the page no longer holds the link', () => {
    // Download URLs live in the tab and are gone after a reload. Saying so beats a
    // dead button, and re-selecting the file uses no link.
    const packages = fivePending();
    expect(packageAction(packages[0]!, packages, false)).toBe('needs-manifest');
  });

  it('never offers anything for a superseded package', () => {
    const packages = [pkg({ status: 'superseded' })];
    expect(packageAction(packages[0]!, packages, true)).toBe('none');
  });

  it('counts only packages DAMC actually has', () => {
    const packages = fivePending();
    packages[0]!.status = 'imported';
    packages[1]!.status = 'retained';
    packages[2]!.status = 'opened';
    packages[3]!.status = 'failed';
    const p = sessionProgress(session(packages))!;
    expect(p.done).toBe(2);
    expect(p.percent).toBe(40);
    expect(p.failed).toBe(1);
    expect(p.pending).toBe(2);
  });

  it('reports 0% for a session where nothing has arrived yet', () => {
    const p = sessionProgress(session(fivePending()))!;
    expect(p.done).toBe(0);
    expect(p.percent).toBe(0);
  });

  it('tells a waiting session apart from a finished one', () => {
    const waiting = sessionBanner(session(fivePending()))!;
    // An arrow, not a tick: a session waiting on five downloads with a check mark
    // beside it reads as complete.
    expect(waiting.kind).toBe('waiting');
    expect(waiting.mark).toBe('arrow');
    expect(DICTIONARIES.ko[waiting.titleKey]).toBeTruthy();

    const done = sessionBanner(session(fivePending(), { status: 'completed', conversations: 12, memoriesCreated: 30 }))!;
    expect(done.kind).toBe('done');
    expect(done.mark).toBe('check');

    const partial = sessionBanner(session(fivePending(), { status: 'partial' }))!;
    expect(partial.kind).toBe('partial');

    const failed = sessionBanner(session(fivePending(), { status: 'failed' }))!;
    expect(failed.kind).toBe('failed');
    expect(failed.tone).toBe('bad');

    for (const banner of [waiting, done, partial, failed]) {
      expect(DICTIONARIES.en[banner.titleKey], banner.kind).toBeTruthy();
      expect(DICTIONARIES.en[banner.summaryKey], banner.kind).toBeTruthy();
      expect(DICTIONARIES.ko[banner.summaryKey], banner.kind).toBeTruthy();
    }
  });

  it('recognises the manifest for the session already on screen', () => {
    const s = session(fivePending());
    const names = fivePending().map(p => p.filename as string);
    // Re-selecting the same file re-attaches the links it lost on reload; starting a
    // second session would supersede the packages already downloaded.
    expect(manifestMatchesSession(names, s)).toBe(true);
    expect(manifestMatchesSession(names.map(n => n.replace('.zip', ' (1).zip')), s)).toBe(true);
    expect(manifestMatchesSession(names.slice(0, 4), s)).toBe(false);
    expect(manifestMatchesSession(['other-000.zip', ...names.slice(1)], s)).toBe(false);
    expect(manifestMatchesSession(names, null)).toBe(false);
    expect(manifestMatchesSession([], s)).toBe(false);
  });

  it('normalises a download name the same way the server does', () => {
    // If these two rules disagree the page offers a button for a package the server
    // will never match, and the download is quarantined as an unknown export.
    expect(normalizePackageName('conversations-000 (1).zip')).toBe('conversations-000.zip');
    expect(normalizePackageName('conversations-000 (12).zip')).toBe('conversations-000.zip');
    expect(normalizePackageName('C:\\Users\\x\\MEMORIES-000.ZIP')).toBe('memories-000.zip');
    expect(normalizePackageName('conversations-000.zip')).toBe('conversations-000.zip');
    expect(normalizePackageName(null)).toBe('');
  });
});

describe('defects an adversarial review found in the session view', () => {
  const pkg = (over: Record<string, unknown> = {}) => ({
    id: 'p1', sequence: 1, category: 'conversations', filename: 'conversations-000.zip',
    status: 'awaiting_download', importJobId: null, stats: null, ...over
  });

  it('does not treat a finished session as the session for a new export', () => {
    // Every Claude export uses the same five filenames. Matching a finished session
    // made the NEXT export look like a reconnect: the start button vanished and the
    // second export could not be imported at all.
    const names = ['conversations-000.zip', 'memories-000.zip'];
    const packages = [pkg(), pkg({ id: 'p2', filename: 'memories-000.zip' })];
    expect(manifestMatchesSession(names, { status: 'awaiting_download', packages })).toBe(true);
    for (const status of ['completed', 'partial', 'failed', 'superseded']) {
      expect(manifestMatchesSession(names, { status, packages }), status).toBe(false);
    }
  });

  it('suppresses only the session\u2019s own jobs, not an unrelated import', () => {
    const session = {
      jobId: 'sess-1', status: 'completed',
      packages: [pkg({ importJobId: 'watch-job-1', status: 'imported' })]
    };
    // The session job itself, and the watcher's per-package import job.
    expect(belongsToSession({ id: 'sess-1' }, session)).toBe(true);
    expect(belongsToSession({ id: 'watch-job-1' }, session)).toBe(true);
    // A ChatGPT upload the user ran a minute ago has nothing to do with the session,
    // and hiding its banner was a change to behaviour that already worked.
    expect(belongsToSession({ id: 'chatgpt-job' }, session)).toBe(false);
    expect(showsFileOutcome({ id: 'chatgpt-job', status: 'completed', stats: { imported: 5 } }, session)).toBe(true);
    expect(showsFileOutcome({ id: 'watch-job-1', status: 'completed', stats: { imported: 5 } }, session)).toBe(false);
  });

  it('translates the failure reasons a package can carry', () => {
    for (const code of ['ARCHIVE_UNREADABLE', 'IMPORT_ERROR', 'RETAIN_ERROR']) {
      const key = packageErrorKey(code);
      expect(key, code).toBeTruthy();
      expect(DICTIONARIES.en[key!], `${code} en`).toBeTruthy();
      expect(DICTIONARIES.ko[key!], `${code} ko`).toBeTruthy();
      // Each one names the next step, not just the problem.
      expect(DICTIONARIES.en[key!]).toMatch(/again|logs|space/);
    }
    // An unrecognised code falls through to whatever the server said, rather than
    // being swallowed.
    expect(packageErrorKey('SOMETHING_NEW')).toBeNull();
    expect(packageErrorKey(undefined)).toBeNull();
  });

  it('handles a session with no packages at all', () => {
    expect(belongsToSession({ id: 'x' }, { jobId: 'y' })).toBe(false);
    expect(sessionProgress({ jobId: 'y', totalFiles: 0, packages: [] })!.percent).toBeNull();
    expect(packageAction(null, [], true)).toBe('none');
  });
});
