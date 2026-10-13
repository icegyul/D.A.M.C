/**
 * The browser-download session: the per-package state machine.
 *
 * claude.ai refuses a server-side download, so the user's own browser fetches each
 * package and the watch folder picks it up. That makes the package row the
 * durability guarantee for the whole feature — the thing that remembers which
 * one-time links are spent, which files have arrived, and when a session is done.
 *
 * So these tests assert *positively* that the writes happen. A state machine whose
 * transitions are swallowed would otherwise pass every test in this suite while
 * persisting nothing: the watcher issues no SQL of its own, and vitest points
 * DATABASE_URL at a closed port.
 *
 * The database is a small in-memory fake rather than a Postgres, because what is
 * under test is the decisions — routing, matching, refusing, settling — and every
 * one of them should be checkable without infrastructure.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';

// ---------------------------------------------------------------------------
// A fake claude_export_packages, driven by the real SQL.
// ---------------------------------------------------------------------------

const sql: Array<{ text: string; params: unknown[] }> = [];
let rows: Array<Record<string, any>> = [];
let nextId = 1;
const JOB = '11111111-2222-3333-4444-555555555555';

function blank(overrides: Record<string, any>): Record<string, any> {
  return {
    id: `pkg-${nextId++}`, user_id: 'user-1', session_job_id: JOB, sequence: 1,
    category: 'conversations', filename: 'conversations-000.zip', part: 0,
    disposition: 'import', status: 'awaiting_download', bytes: null,
    entry_count: null, entry_names: null, import_job_id: null, stats: null,
    error_code: null, error_message: null,
    opened_at: null, detected_at: null, finished_at: null,
    created_at: new Date(2026, 0, nextId), updated_at: new Date(2026, 0, nextId),
    ...overrides
  };
}

/** Dispatch on the real statements the repository issues. */
function run(text: string, params: unknown[]): { rows: any[]; rowCount: number } {
  const reply = (r: any[]) => ({ rows: r, rowCount: r.length });

  if (/INSERT INTO sync_jobs/i.test(text)) return reply([{ id: JOB }]);
  if (/UPDATE sync_jobs/i.test(text)) return reply([]);

  if (/SET status='superseded'/i.test(text)) {
    const [userId, exceptJob, statuses] = params as [string, string, string[]];
    const hit: any[] = [];
    for (const row of rows) {
      if (row.user_id === userId && row.session_job_id !== exceptJob && statuses.includes(row.status)) {
        row.status = 'superseded';
        hit.push({ session_job_id: row.session_job_id });
      }
    }
    return reply(hit);
  }
  if (/INSERT INTO claude_export_packages/i.test(text)) {
    const [userId, jobId, sequence, category, filename, part, disposition] = params as any[];
    const existing = rows.find(r => r.session_job_id === jobId && r.filename === filename);
    if (existing) {
      Object.assign(existing, { sequence, category, part, disposition });
      return reply([existing]);
    }
    const row = blank({ user_id: userId, session_job_id: jobId, sequence, category, filename, part, disposition });
    rows.push(row);
    return reply([row]);
  }
  if (/^\s*SELECT session_job_id FROM claude_export_packages/i.test(text)) {
    const [userId] = params as [string];
    const live = rows.filter(r => r.user_id === userId && r.status !== 'superseded')
      .sort((a, b) => b.created_at - a.created_at);
    return reply(live.length ? [{ session_job_id: live[0]!.session_job_id }] : []);
  }
  if (/FROM claude_export_packages\s+WHERE user_id=\$1 AND session_job_id=\$2/i.test(text)) {
    const [userId, jobId] = params as [string, string];
    return reply(rows.filter(r => r.user_id === userId && r.session_job_id === jobId)
      .sort((a, b) => a.sequence - b.sequence));
  }
  if (/lower\(filename\)=lower\(\$2\)/i.test(text)) {
    const [userId, filename, statuses] = params as [string, string, string[]];
    let candidates = rows.filter(r => r.user_id === userId
      && String(r.filename).toLowerCase() === String(filename).toLowerCase()
      && statuses.includes(r.status));
    // findSettledPackage restricts itself to the newest session with a subquery.
    if (/session_job_id = \(/i.test(text)) {
      const newest = rows.filter(r => r.user_id === userId)
        .sort((a, b) => b.created_at - a.created_at)[0]?.session_job_id;
      candidates = candidates.filter(r => r.session_job_id === newest);
    }
    const hit = candidates.sort((a, b) => b.created_at - a.created_at)[0];
    return reply(hit ? [hit] : []);
  }
  if (/SET status='importing'/i.test(text)) {
    const row = rows.find(r => r.id === params[0]);
    if (!row) return reply([]);
    Object.assign(row, { status: 'importing', detected_at: row.detected_at ?? new Date(), error_code: null, error_message: null });
    return reply([row]);
  }
  if (/SET status='opened', opened_at=COALESCE/i.test(text)) {
    const [id, userId, statuses] = params as [string, string, string[]];
    const row = rows.find(r => r.id === id && r.user_id === userId && statuses.includes(r.status));
    if (!row) return reply([]);
    Object.assign(row, { status: 'opened', opened_at: row.opened_at ?? new Date() });
    return reply([row]);
  }
  if (/SET status=COALESCE\(\$2,status\)/i.test(text)) {
    const [id, status, bytes, entryCount, entryNames, importJobId, stats, errorCode, errorMessage, finished] = params as any[];
    const row = rows.find(r => r.id === id && (!/status <> 'superseded'/i.test(text) || r.status !== 'superseded'));
    if (!row) return reply([]);
    Object.assign(row, {
      status: status ?? row.status,
      bytes: bytes ?? row.bytes,
      entry_count: entryCount ?? row.entry_count,
      entry_names: entryNames ? JSON.parse(entryNames) : row.entry_names,
      import_job_id: importJobId ?? row.import_job_id,
      stats: stats ? JSON.parse(stats) : row.stats,
      error_code: errorCode, error_message: errorMessage,
      finished_at: finished ? new Date() : row.finished_at
    });
    return reply([row]);
  }
  if (/FROM claude_export_packages\s+WHERE status = ANY\(\$1::text\[\]\)/i.test(text)) {
    const [statuses] = params as [string[]];
    return reply(rows.filter(r => statuses.includes(r.status)));
  }
  if (/WHERE status IN \('detected','importing'\)/i.test(text)) {
    const touched = rows.filter(r => ['detected', 'importing'].includes(r.status));
    for (const row of touched) row.status = 'opened';
    return reply(touched.map(r => ({ id: r.id })));
  }
  return reply([]);
}

vi.mock('../src/db/pool.js', () => {
  const query = async (text: string, params: unknown[] = []) => {
    sql.push({ text, params });
    return run(text, params);
  };
  // The real service uses withTransaction for the claim and for session creation,
  // because both are multi-statement. Mocking it as "run the body against the same
  // query" keeps the production code honest instead of shaping it to fit a mock.
  return { query, withTransaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ query }) };
});

vi.mock('../src/services/ingestion-service.js', () => ({
  ingestConversation: async () => ({ deduplicated: false, memoriesCreated: 1, memoriesSuperseded: 0 }),
  extractCandidates: () => []
}));

const svc = await import('../src/services/claude-package-service.js');
const repo = await import('../src/repositories/claude-export-repository.js');
const { env } = await import('../src/config/env.js');
const { retainedArchiveDir } = await import('../src/services/claude-category-service.js');

const MANIFEST_PLAN = [
  { category: 'conversations', filename: 'conversations-000.zip', part: 0 },
  { category: 'memories', filename: 'memories-000.zip', part: 0 },
  { category: 'projects', filename: 'projects-000.zip', part: 0 },
  { category: 'design_chats', filename: 'design_chats-000.zip', part: 0 },
  { category: 'light_metadata', filename: 'light_metadata-000.zip', part: 0 }
];

let tempRoot: string;
let originalDataDir: string;

beforeEach(async () => {
  sql.length = 0;
  rows = [];
  nextId = 1;
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'damc-session-'));
  originalDataDir = env.DATA_DIR;
  (env as { DATA_DIR: string }).DATA_DIR = path.join(tempRoot, 'storage');
  return async () => {
    (env as { DATA_DIR: string }).DATA_DIR = originalDataDir;
    await fs.rm(tempRoot, { recursive: true, force: true });
  };
});

const statements = (pattern: RegExp) => sql.filter(s => pattern.test(s.text));

// ---------------------------------------------------------------------------

describe('the plan the page posts carries no credentials', () => {
  it('refuses a body containing a download URL instead of storing it', async () => {
    // The whole safety argument for this flow is that an export_url never reaches
    // the server. If a client sends one anyway that is a bug, and persisting it
    // quietly would be the worst possible response.
    const error = await svc.startSession('user-1', [
      { category: 'conversations', filename: 'conversations-000.zip', part: 0, export_url: 'https://claude.ai/export/a/download/b' } as never
    ]).catch(e => e);
    expect(error.code).toBe('MANIFEST_URL_NOT_ACCEPTED');
    expect(rows).toEqual([]);
  });

  it('stores nothing that looks like a URL, on any statement', async () => {
    await svc.startSession('user-1', MANIFEST_PLAN);
    const serialized = JSON.stringify(sql.map(s => s.params));
    expect(serialized).not.toContain('claude.ai');
    expect(serialized).not.toContain('://');
  });

  it('reduces a filename to its basename', () => {
    const plan = svc.planFromEntries([{ category: 'memories', filename: '../../escaped.zip', part: null }]);
    expect(plan[0]!.filename).toBe('escaped.zip');
  });

  it('refuses a manifest that lists one filename twice', () => {
    // Two packages of one name cannot be told apart when they land in the folder,
    // so this is rejected up front rather than mismatched later.
    expect(() => svc.planFromEntries([
      { category: 'conversations', filename: 'conversations-000.zip', part: 0 },
      { category: 'design_chats', filename: 'conversations-000 (1).zip', part: 0 }
    ])).toThrow(/more than once/);
  });

  it('marks conversations for import and every other category for retention', () => {
    const plan = svc.planFromEntries(MANIFEST_PLAN);
    expect(plan.map(p => [p.category, p.disposition])).toEqual([
      ['conversations', 'import'], ['memories', 'retain'], ['projects', 'retain'],
      ['design_chats', 'retain'], ['light_metadata', 'retain']
    ]);
    expect(plan.map(p => p.sequence)).toEqual([1, 2, 3, 4, 5]);
  });

  it('puts conversations first even when the manifest lists it last', () => {
    // A real manifest does list it last. The sequence decides which package the user
    // is offered next, so manifest order would have them spend four single-use links
    // on categories DAMC only keeps before reaching the one they came for.
    const asManifestOrders = [...MANIFEST_PLAN].reverse();
    expect(asManifestOrders[0]!.category).toBe('light_metadata');
    const plan = svc.planFromEntries(asManifestOrders);
    expect(plan[0]!.category).toBe('conversations');
    expect(plan[0]!.sequence).toBe(1);
  });

  it('keeps an unknown category last rather than dropping it', () => {
    const plan = svc.planFromEntries([
      { category: 'future_thing', filename: 'future-000.zip', part: 0 },
      { category: 'conversations', filename: 'conversations-000.zip', part: 0 }
    ]);
    expect(plan.map(p => p.category)).toEqual(['conversations', 'future_thing']);
    expect(plan[1]!.disposition).toBe('retain');
  });

  it('orders the parts of one category by part number', () => {
    const plan = svc.planFromEntries([
      { category: 'conversations', filename: 'conversations-002.zip', part: 2 },
      { category: 'conversations', filename: 'conversations-000.zip', part: 0 },
      { category: 'conversations', filename: 'conversations-001.zip', part: 1 }
    ]);
    expect(plan.map(p => p.filename)).toEqual(['conversations-000.zip', 'conversations-001.zip', 'conversations-002.zip']);
  });
});

describe('starting a session', () => {
  it('parks the job at awaiting_download rather than leaving it queued', async () => {
    const session = await svc.startSession('user-1', MANIFEST_PLAN, { version: '1.0', createdAt: '2026-09-12T16:13:38Z' });

    // Load-bearing: boot reconciliation fails every job in ('running','queued'),
    // and this session waits on a human across container restarts.
    const parked = statements(/UPDATE sync_jobs SET status='awaiting_download'/i);
    expect(parked.length).toBeGreaterThan(0);
    expect(session.status).toBe('awaiting_download');
    expect(session.totalFiles).toBe(5);
    expect(session.packages.map(p => p.status)).toEqual(Array(5).fill('awaiting_download'));
  });

  it('writes one package row per manifest entry', async () => {
    await svc.startSession('user-1', MANIFEST_PLAN);
    // Positive assertion. A transition nothing observes is not tested, and these
    // rows are the only durable record of the session.
    expect(statements(/INSERT INTO claude_export_packages/i)).toHaveLength(5);
    expect(rows.map(r => r.filename)).toEqual(MANIFEST_PLAN.map(p => p.filename));
  });

  it('supersedes the previous session so an arriving file has one owner', async () => {
    await svc.startSession('user-1', MANIFEST_PLAN);
    const first = rows.map(r => r.id);
    rows.forEach(r => { r.session_job_id = 'old-job'; });

    await svc.startSession('user-1', MANIFEST_PLAN);

    // Two live sessions would both be waiting for conversations-000.zip.
    for (const id of first) {
      expect(rows.find(r => r.id === id)!.status, id).toBe('superseded');
    }
    expect(statements(/SET status='superseded'/i).length).toBeGreaterThan(0);
  });
});

describe('routing is decided by what is in the archive', () => {
  it('imports anything carrying conversation data, whatever the category is called', () => {
    expect(svc.routeByEntries(['conversations.json'], 1)).toBe('import');
    expect(svc.routeByEntries(['conversations-000.json', 'conversations-001.json'], 2)).toBe('import');
    // A design_chats archive that really holds conversations is imported on the
    // evidence — that is not guessing a mapping, it is reading one.
    expect(svc.routeByEntries(['design/conversations.json'], 1)).toBe('import');
  });

  it('retains an archive with no conversation data', () => {
    expect(svc.routeByEntries(['memories/index.json', 'memories/2026-01.json'], 2)).toBe('retain');
    // The anchored matcher is what keeps this honest: shared_conversations.json is
    // 229 bytes of something else and must not count as conversation data.
    expect(svc.routeByEntries(['shared_conversations.json'], 1)).toBe('retain');
  });

  it('calls an archive with no readable entries incomplete, not retainable', () => {
    // A half-finished browser download. Retaining it would record a truncated file
    // as kept data; the user has to be told to fetch it again.
    expect(svc.routeByEntries([], 0)).toBe('unreadable');
  });
});

describe('matching an arriving download to a package', () => {
  const conversationsZip = () => Buffer.from(zipSync({
    'conversations.json': strToU8(JSON.stringify([{ uuid: 'c1', chat_messages: [{ uuid: 'm', sender: 'human', text: 'hi' }] }]))
  }));
  const otherZip = () => Buffer.from(zipSync({ 'memories/index.json': strToU8('[]') }));

  const writeFile = async (name: string, body: Buffer) => {
    const target = path.join(tempRoot, name);
    await fs.writeFile(target, body);
    return target;
  };

  it('claims the package and reports how to handle it', async () => {
    await svc.startSession('user-1', MANIFEST_PLAN);
    const claimed = await svc.claimWatchedFile('user-1', 'conversations-000.zip', await writeFile('conversations-000.zip', conversationsZip()));

    expect(claimed?.route).toBe('import');
    expect(claimed?.package.category).toBe('conversations');
    // Claiming is also a transition: the row must say the file has arrived.
    expect(rows.find(r => r.filename === 'conversations-000.zip')!.status).toBe('importing');
    expect(statements(/SET status='importing'/i).length).toBeGreaterThan(0);
  });

  it('matches a browser collision rename', async () => {
    await svc.startSession('user-1', MANIFEST_PLAN);
    const claimed = await svc.claimWatchedFile('user-1', 'conversations-000 (1).zip', await writeFile('conversations-000 (1).zip', conversationsZip()));
    expect(claimed?.package.filename).toBe('conversations-000.zip');
  });

  it('matches regardless of case', async () => {
    await svc.startSession('user-1', MANIFEST_PLAN);
    const claimed = await svc.claimWatchedFile('user-1', 'MEMORIES-000.ZIP', await writeFile('MEMORIES-000.ZIP', otherZip()));
    expect(claimed?.route).toBe('retain');
  });

  it('claims nothing for a file no session is waiting for', async () => {
    await svc.startSession('user-1', MANIFEST_PLAN);
    expect(await svc.claimWatchedFile('user-1', 'something-else.zip', await writeFile('something-else.zip', otherZip()))).toBeNull();
  });

  it('recognises a second arrival of a finished package instead of failing it', async () => {
    // The user re-downloads, or copies the files back. Falling through to ordinary
    // detection would quarantine a retained category in failed/ as INVALID_JSON —
    // the misreport this whole feature exists to remove, just one pass later.
    await svc.startSession('user-1', MANIFEST_PLAN);
    const target = await writeFile('memories-000.zip', otherZip());
    const first = await svc.claimWatchedFile('user-1', 'memories-000.zip', target);
    await svc.retainPackage(first!, target);

    const again = await svc.claimWatchedFile('user-1', 'memories-000.zip', await writeFile('memories-000.zip', otherZip()));
    expect(again?.route).toBe('settled');
    // And the row is untouched: no second retain, no state change.
    expect(rows.find(r => r.filename === 'memories-000.zip')!.status).toBe('retained');
  });

  it('recognises a package from a superseded session rather than calling it corrupt', async () => {
    await svc.startSession('user-1', MANIFEST_PLAN);
    rows.forEach(r => { r.status = 'superseded'; });
    const again = await svc.claimWatchedFile('user-1', 'projects-000.zip', await writeFile('projects-000.zip', otherZip()));
    expect(again?.route).toBe('settled');
  });

  it('never offers a second import of the same package', async () => {
    await svc.startSession('user-1', MANIFEST_PLAN);
    const target = await writeFile('conversations-000.zip', conversationsZip());
    const first = await svc.claimWatchedFile('user-1', 'conversations-000.zip', target);
    await svc.completeImportedPackage(first!, 100, 'job-x', { conversations: 1, imported: 1, memoriesCreated: 2, messages: 1 });

    // An archive left in the watch folder is rescanned every two seconds, so the
    // durable state — not the file's location — is what stops a second import. It
    // comes back as 'settled' rather than as nothing, so the watcher files it away
    // instead of falling through to ordinary detection.
    const again = await svc.claimWatchedFile('user-1', 'conversations-000.zip', target);
    expect(again?.route).toBe('settled');
    const row = rows.find(r => r.filename === 'conversations-000.zip')!;
    expect(row.status).toBe('imported');
    expect(row.stats.conversations).toBe(1);
  });

  it('fails the package when the archive cannot be read at all', async () => {
    await svc.startSession('user-1', MANIFEST_PLAN);
    const truncated = await writeFile('conversations-000.zip', Buffer.from([0x50, 0x4b, 0x03, 0x04]));

    const claimed = await svc.claimWatchedFile('user-1', 'conversations-000.zip', truncated);
    expect(claimed?.route).toBe('failed');
    const row = rows.find(r => r.filename === 'conversations-000.zip')!;
    // Claimed then failed — never left stuck at 'importing', which would strand the
    // session waiting for something that already happened.
    expect(row.status).toBe('failed');
    expect(row.error_code).toBe('ARCHIVE_UNREADABLE');
    expect(row.error_message).toMatch(/again/);
  });
});

describe('a package that lands', () => {
  it('records what an imported archive produced', async () => {
    await svc.startSession('user-1', MANIFEST_PLAN);
    const target = path.join(tempRoot, 'conversations-000.zip');
    await fs.writeFile(target, Buffer.from(zipSync({ 'conversations.json': strToU8('[]') })));
    const claimed = await svc.claimWatchedFile('user-1', 'conversations-000.zip', target);

    await svc.completeImportedPackage(claimed!, 4096, 'import-job-1', { conversations: 12, imported: 12, deduplicated: 0, memoriesCreated: 30, messages: 40 });

    const row = rows.find(r => r.filename === 'conversations-000.zip')!;
    expect(row.status).toBe('imported');
    expect(row.bytes).toBe(4096);
    expect(row.import_job_id).toBe('import-job-1');
    expect(row.stats.conversations).toBe(12);
    expect(row.finished_at).toBeTruthy();
  });

  it('reads the streaming importer’s own counter names', async () => {
    // Found end to end, not in a unit test: runStreamingImportJob calls its count
    // `conversationsDetected`, so storing its result verbatim gave a session total of
    // zero beside a package that had visibly imported three conversations.
    await svc.startSession('user-1', MANIFEST_PLAN);
    const target = path.join(tempRoot, 'conversations-000.zip');
    await fs.writeFile(target, Buffer.from(zipSync({ 'conversations.json': strToU8('[]') })));
    const claimed = await svc.claimWatchedFile('user-1', 'conversations-000.zip', target);

    await svc.completeImportedPackage(claimed!, 10, 'job', {
      jobId: 'job', provider: 'claude', status: 'completed',
      conversationsDetected: 3, messages: 6, imported: 3, deduplicated: 0,
      memoriesCreated: 4, superseded: 0, decisionCount: 1, taskCount: 2
    });

    const row = rows.find(r => r.filename === 'conversations-000.zip')!;
    expect(row.stats.conversations).toBe(3);
    expect(row.stats.messages).toBe(6);
    const summary = await svc.settleSession('user-1', JOB);
    expect(summary.conversations).toBe(3);
    expect(summary.messages).toBe(6);
    expect(summary.decisionCount).toBe(1);
    expect(summary.taskCount).toBe(2);
  });

  it('keeps a retained archive and records its real entry names', async () => {
    await svc.startSession('user-1', MANIFEST_PLAN);
    const target = path.join(tempRoot, 'memories-000.zip');
    await fs.writeFile(target, Buffer.from(zipSync({ 'memories/index.json': strToU8('[]'), 'memories/a.json': strToU8('{}') })));
    const claimed = await svc.claimWatchedFile('user-1', 'memories-000.zip', target);

    await svc.retainPackage(claimed!, target);

    const row = rows.find(r => r.filename === 'memories-000.zip')!;
    expect(row.status).toBe('retained');
    expect(row.entry_count).toBe(2);
    expect(row.entry_names.sort()).toEqual(['memories/a.json', 'memories/index.json']);
    // The archive itself survives: its link works once, so discarding it for want
    // of a parser would destroy data the user cannot get back.
    const kept = await fs.readFile(String(row.stats.retainedPath));
    expect(kept.length).toBeGreaterThan(0);
  });
});

describe('the one-time link rule', () => {
  it('records an opened link', async () => {
    const session = await svc.startSession('user-1', MANIFEST_PLAN);
    const opened = await svc.openPackage('user-1', session.packages[0]!.id);
    expect(opened.status).toBe('opened');
    expect(opened.openedAt).toBeTruthy();
  });

  it('allows re-opening a link whose download never arrived', async () => {
    // Not a spent link as far as anyone can tell — the download may never have
    // started — so a second attempt is the useful behaviour, with a warning.
    const session = await svc.startSession('user-1', MANIFEST_PLAN);
    await svc.openPackage('user-1', session.packages[0]!.id);
    await expect(svc.openPackage('user-1', session.packages[0]!.id)).resolves.toMatchObject({ status: 'opened' });
  });

  it('refuses to re-open a link whose file already arrived', async () => {
    const session = await svc.startSession('user-1', MANIFEST_PLAN);
    const id = session.packages[0]!.id;
    rows.find(r => r.id === id)!.status = 'imported';

    const error = await svc.openPackage('user-1', id).catch(e => e);
    expect(error.code).toBe('PACKAGE_ALREADY_DELIVERED');
    expect(error.statusCode).toBe(409);
  });

  it('refuses to open another user’s package', async () => {
    const session = await svc.startSession('user-1', MANIFEST_PLAN);
    await expect(svc.openPackage('user-2', session.packages[0]!.id)).rejects.toMatchObject({ code: 'PACKAGE_ALREADY_DELIVERED' });
  });
});

describe('settling the session', () => {
  const finish = (filename: string, status: string, stats: Record<string, unknown> = {}) => {
    const row = rows.find(r => r.filename === filename)!;
    Object.assign(row, { status, stats, finished_at: new Date() });
  };

  it('stays awaiting_download while anything is pending', async () => {
    await svc.startSession('user-1', MANIFEST_PLAN);
    finish('conversations-000.zip', 'imported', { conversations: 5, imported: 5, memoriesCreated: 9, messages: 11 });

    const summary = await svc.settleSession('user-1', JOB);
    expect(summary.status).toBe('awaiting_download');
    // Never given a finished_at while a human still has work to do.
    expect(statements(/UPDATE sync_jobs SET status='awaiting_download',finished_at=NULL/i).length).toBeGreaterThan(0);
  });

  it('completes when every package landed', async () => {
    await svc.startSession('user-1', MANIFEST_PLAN);
    finish('conversations-000.zip', 'imported', { conversations: 5, imported: 5, memoriesCreated: 9, messages: 11 });
    for (const name of ['memories-000.zip', 'projects-000.zip', 'design_chats-000.zip', 'light_metadata-000.zip']) {
      finish(name, 'retained');
      rows.find(r => r.filename === name)!.entry_count = 3;
    }

    const summary = await svc.settleSession('user-1', JOB);
    expect(summary.status).toBe('completed');
    expect(summary.conversations).toBe(5);
    expect(summary.messages).toBe(11);
    expect(summary.memoriesCreated).toBe(9);
    expect(summary.retainedArchives).toBe(4);
    // Per category, with the two kinds of number kept apart: a parsed category
    // reports conversations, a kept one reports observed entries.
    const memories = summary.byCategory.find(c => c.category === 'memories')!;
    expect(memories.conversations).toBeNull();
    expect(memories.entries).toBe(3);
    expect(memories.kept).toBe(1);
  });

  it('is partial when one package failed', async () => {
    await svc.startSession('user-1', MANIFEST_PLAN);
    finish('conversations-000.zip', 'imported', { conversations: 2, imported: 2 });
    for (const name of ['memories-000.zip', 'projects-000.zip', 'design_chats-000.zip']) finish(name, 'retained');
    finish('light_metadata-000.zip', 'failed');
    rows.find(r => r.filename === 'light_metadata-000.zip')!.error_code = 'ARCHIVE_UNREADABLE';

    const summary = await svc.settleSession('user-1', JOB);
    expect(summary.status).toBe('partial');
    const settle = statements(/UPDATE sync_jobs SET status=\$1,finished_at=now\(\)/i).at(-1)!;
    expect(settle.params[0]).toBe('partial');
    expect(String(settle.params[2])).toMatch(/light_metadata \(ARCHIVE_UNREADABLE\)/);
  });

  it('fails only when nothing landed at all', async () => {
    await svc.startSession('user-1', MANIFEST_PLAN);
    for (const entry of MANIFEST_PLAN) finish(entry.filename, 'failed');
    expect((await svc.settleSession('user-1', JOB)).status).toBe('failed');
  });

  it('ignores a superseded package when settling', async () => {
    await svc.startSession('user-1', MANIFEST_PLAN);
    finish('conversations-000.zip', 'imported', { conversations: 1, imported: 1 });
    for (const name of ['memories-000.zip', 'projects-000.zip', 'design_chats-000.zip']) finish(name, 'retained');
    rows.find(r => r.filename === 'light_metadata-000.zip')!.status = 'superseded';

    const summary = await svc.settleSession('user-1', JOB);
    // A package a newer export replaced is not a gap in this one.
    expect(summary.status).toBe('completed');
    expect(summary.totalFiles).toBe(4);
  });
});

describe('restart recovery', () => {
  it('sends an interrupted package back to opened, never to awaiting_download', async () => {
    await svc.startSession('user-1', MANIFEST_PLAN);
    rows[0]!.status = 'importing';
    rows[1]!.status = 'detected';
    rows[2]!.status = 'opened';

    const reset = await repo.resetInterruptedPackages();

    expect(reset).toBe(2);
    // 'awaiting_download' would present a spent link as untouched and invite a
    // second click on it. 'opened' says the file was fetched and lets the watcher
    // re-detect it if it is still in the folder.
    expect(rows[0]!.status).toBe('opened');
    expect(rows[1]!.status).toBe('opened');
    expect(rows[2]!.status).toBe('opened');
  });

  it('leaves a finished package alone', async () => {
    await svc.startSession('user-1', MANIFEST_PLAN);
    rows[0]!.status = 'imported';
    rows[1]!.status = 'retained';
    rows[2]!.status = 'awaiting_download';

    await repo.resetInterruptedPackages();

    expect(rows.map(r => r.status).slice(0, 3)).toEqual(['imported', 'retained', 'awaiting_download']);
  });
});

describe('reading the session back', () => {
  it('returns the newest session when none is named', async () => {
    await svc.startSession('user-1', MANIFEST_PLAN);
    const session = await svc.getSession('user-1');
    expect(session?.jobId).toBe(JOB);
    expect(session?.packages).toHaveLength(5);
  });

  it('returns null for a user with no session', async () => {
    expect(await svc.getSession('nobody')).toBeNull();
  });
});

/**
 * Defects an adversarial review found in the first cut of this feature. Each one
 * was a dead end a user could reach, so each gets a test that reproduces it.
 */
describe('recovery paths a review found missing', () => {
  const conversationsZip = () => Buffer.from(zipSync({
    'conversations.json': strToU8(JSON.stringify([{ uuid: 'c1', chat_messages: [{ uuid: 'm', sender: 'human', text: 'hi' }] }]))
  }));
  const write = async (name: string, body: Buffer) => {
    const target = path.join(tempRoot, name);
    await fs.writeFile(target, body);
    return target;
  };

  it('lets a failed package be downloaded again', async () => {
    // The UI offers "download again" for a failed row. The server refused it, and the
    // re-arriving file was filed as an already-handled duplicate — so a single
    // truncated download ended that package for good.
    const session = await svc.startSession('user-1', MANIFEST_PLAN);
    const id = session.packages[0]!.id;
    rows.find(r => r.id === id)!.status = 'failed';

    const reopened = await svc.openPackage('user-1', id);
    expect(reopened.status).toBe('opened');

    const claimed = await svc.claimWatchedFile('user-1', 'conversations-000.zip', await write('conversations-000.zip', conversationsZip()));
    expect(claimed?.route).toBe('import');
  });

  it('claims a re-download even when the package was left failed', async () => {
    const session = await svc.startSession('user-1', MANIFEST_PLAN);
    rows.find(r => r.id === session.packages[0]!.id)!.status = 'failed';
    const claimed = await svc.claimWatchedFile('user-1', 'conversations-000.zip', await write('conversations-000.zip', conversationsZip()));
    // Not 'settled': that would file the user's second download away unimported.
    expect(claimed?.route).toBe('import');
  });

  it('does not let an old session swallow a new export using the same filenames', async () => {
    // Every Claude export ships conversations-000.zip. Matching settled packages
    // across sessions made the first export's finished package claim the second
    // export's download and file it as a duplicate — losing it entirely.
    await svc.startSession('user-1', MANIFEST_PLAN);
    for (const row of rows) { row.status = 'imported'; row.stats = { conversations: 1 }; }
    const firstSession = rows[0]!.session_job_id;

    // A second export. The fake returns the same JOB id, so distinguish by hand.
    rows.forEach(r => { r.session_job_id = 'older-session'; });
    void firstSession;
    await svc.startSession('user-1', MANIFEST_PLAN);

    const claimed = await svc.claimWatchedFile('user-1', 'conversations-000.zip', await write('conversations-000.zip', conversationsZip()));
    expect(claimed?.route).toBe('import');
    expect(claimed?.package.sessionJobId).toBe(JOB);
  });

  it('returns a failed claim rather than nothing, so the watcher does not read it twice', async () => {
    await svc.startSession('user-1', MANIFEST_PLAN);
    const truncated = await write('conversations-000.zip', Buffer.from([0x50, 0x4b, 0x03, 0x04]));

    const claimed = await svc.claimWatchedFile('user-1', 'conversations-000.zip', truncated);
    // Returning null sent the watcher on to the ordinary dropped-file path, which
    // read the same broken archive again and called it INVALID_JSON.
    expect(claimed?.route).toBe('failed');
    expect(rows.find(r => r.filename === 'conversations-000.zip')!.status).toBe('failed');
  });

  it('reports a wholly superseded session as superseded, not failed', async () => {
    await svc.startSession('user-1', MANIFEST_PLAN);
    rows.forEach(r => { r.status = 'superseded'; });

    const summary = await svc.settleSession('user-1', JOB);
    // 'failed' claimed "no package could be imported" about work the user never
    // asked to finish — a newer export simply replaced it.
    expect(summary.status).toBe('superseded');
    const settle = statements(/UPDATE sync_jobs SET status='superseded'/i);
    expect(settle.length).toBeGreaterThan(0);
  });

  it('settles the job row of a session it supersedes', async () => {
    await svc.startSession('user-1', MANIFEST_PLAN);
    rows.forEach(r => { r.session_job_id = 'older-session'; });

    await svc.startSession('user-1', MANIFEST_PLAN);

    // Superseding the packages alone left that session's job parked at
    // 'awaiting_download' for ever, waiting for downloads never offered again.
    const settled = statements(/UPDATE sync_jobs SET status='superseded'/i);
    expect(settled.length).toBeGreaterThan(0);
  });

  it('never resurrects a superseded package through a patch', async () => {
    const session = await svc.startSession('user-1', MANIFEST_PLAN);
    const id = session.packages[0]!.id;
    rows.find(r => r.id === id)!.status = 'superseded';

    await repo.updatePackage(id, { status: 'imported', finished: true });
    expect(rows.find(r => r.id === id)!.status).toBe('superseded');
  });

  it('recovers a retained archive whose row never recorded it', async () => {
    // retainArchive renames the file and then writes the row. A death in between left
    // the archive on disk and the session asking for a link that is already spent.
    const session = await svc.startSession('user-1', MANIFEST_PLAN);
    const pkg = session.packages.find(p => p.filename === 'memories-000.zip')!;
    rows.find(r => r.id === pkg.id)!.status = 'opened';
    const dir = retainedArchiveDir(JOB);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'memories-000.zip'), Buffer.from(zipSync({ 'memories/index.json': strToU8('[]') })));

    const recovered = await svc.reconcileRetainedPackages();

    expect(recovered).toBe(1);
    const row = rows.find(r => r.id === pkg.id)!;
    expect(row.status).toBe('retained');
    expect(row.entry_count).toBe(1);
    expect(row.stats.recoveredAtBoot).toBe(true);
  });

  it('leaves a pending package alone when no archive is on disk', async () => {
    await svc.startSession('user-1', MANIFEST_PLAN);
    expect(await svc.reconcileRetainedPackages()).toBe(0);
    expect(rows.every(r => r.status === 'awaiting_download')).toBe(true);
  });
});
