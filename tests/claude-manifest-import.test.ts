/**
 * Claude manifest import: the orchestration.
 *
 * The unit under test is the sequence — download, route by category, import or
 * retain, record, settle — and the things that sequence must guarantee: a
 * single-use URL is fetched at most once, a category with no observed structure is
 * kept rather than guessed at, one bad file does not take the others down, and a
 * bot-protection challenge stops the run without spending the URLs that are left.
 *
 * The database and the ingestion pipeline are mocked. Both are covered by their
 * own integration tests; what matters here is the decisions, and they should be
 * testable without a Postgres.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';

// ---------------------------------------------------------------------------
// Mocks. Declared before the module under test is imported.
// ---------------------------------------------------------------------------

/** Every SQL statement the run issues, so the job row can be asserted on. */
const sql: Array<{ text: string; params: unknown[] }> = [];

vi.mock('../src/db/pool.js', () => ({
  query: async (text: string, params: unknown[] = []) => {
    sql.push({ text, params });
    if (/INSERT INTO sync_jobs/i.test(text)) {
      return { rows: [{ id: '11111111-2222-3333-4444-555555555555' }], rowCount: 1 };
    }
    if (/FROM claude_export_downloads/i.test(text)) {
      return { rows: ledgerRows, rowCount: ledgerRows.length };
    }
    return { rows: [], rowCount: 0 };
  }
}));

/** Rows the mocked ledger lookup returns. Set per test. */
let ledgerRows: Array<Record<string, unknown>> = [];

const ingested: string[] = [];
vi.mock('../src/services/ingestion-service.js', () => ({
  ingestConversation: async (_userId: string, conversation: { externalId: string }) => {
    ingested.push(conversation.externalId);
    // One new memory per conversation, and never a duplicate, unless a test
    // overrides this via `dedupeEverything`.
    return dedupeEverything
      ? { deduplicated: true, memoriesCreated: 0, memoriesSuperseded: 0 }
      : { deduplicated: false, memoriesCreated: 1, memoriesSuperseded: 0 };
  },
  extractCandidates: () => [{ type: 'DECISION' }]
}));
let dedupeEverything = false;

const { runManifestImportJob } = await import('../src/services/claude-manifest-import-service.js');
const { parseClaudeManifest } = await import('../src/services/claude-manifest-service.js');
const { fingerprintUrl } = await import('../src/repositories/claude-export-repository.js');
const { env } = await import('../src/config/env.js');
const { retainedArchiveDir } = await import('../src/services/claude-category-service.js');

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

const USER = 'user-1';
const JOB = '11111111-2222-3333-4444-555555555555';

const url = (name: string) => `https://claude.ai/export/abc/download/${name}`;

/** The real manifest's field names, five categories, conversations last on purpose. */
const manifestJson = (categories = ['light_metadata', 'projects', 'memories', 'design_chats', 'conversations']) => ({
  instructions: 'Download each file using the export_url. Note: Each export URL can only be used once.',
  created_at: '2026-09-12T16:13:38Z',
  total_files: categories.length,
  version: '1.0',
  data_files: categories.map((category, i) => ({
    category, part: 0, batch_index: 0,
    filename: `${category}-000.zip`,
    export_url: url(`${category}-${i}`)
  }))
});

/** A Claude conversations archive, in the layout a Claude export really uses. */
function conversationsZip(count: number, prefix = 'c'): Uint8Array {
  const conversations = Array.from({ length: count }, (_, i) => ({
    uuid: `${prefix}${i}`,
    name: `Conversation ${i}`,
    created_at: '2026-01-01T00:00:00Z',
    chat_messages: [
      { uuid: `${prefix}${i}-m0`, sender: 'human', text: 'question', created_at: '2026-01-01T00:00:00Z' },
      { uuid: `${prefix}${i}-m1`, sender: 'assistant', text: 'answer', created_at: '2026-01-01T00:00:01Z' }
    ]
  }));
  return zipSync({ 'conversations.json': strToU8(JSON.stringify(conversations)) });
}

/** An archive for a category DAMC has no parser for. */
function otherCategoryZip(): Uint8Array {
  return zipSync({
    'memories/2026-01.json': strToU8('{"unknown":"structure"}'),
    'memories/index.json': strToU8('[]')
  });
}

const zipResponse = (bytes: Uint8Array) =>
  new Response(new Blob([bytes]).stream(), { status: 200, headers: { 'content-type': 'application/zip' } });

/** Routes each category's URL to its own body, so per-file behaviour is testable. */
function fetchFor(bodies: Record<string, () => Response>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const href = String(input);
    for (const [category, make] of Object.entries(bodies)) {
      if (href.includes(`/download/${category}-`)) return make();
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
}

/** Bodies that make every category succeed: conversations parseable, rest opaque. */
const allSucceed = (conversationCount = 3) => fetchFor({
  conversations: () => zipResponse(conversationsZip(conversationCount)),
  memories: () => zipResponse(otherCategoryZip()),
  projects: () => zipResponse(otherCategoryZip()),
  design_chats: () => zipResponse(otherCategoryZip()),
  light_metadata: () => zipResponse(otherCategoryZip())
});

let tempRoot: string;
let originalDataDir: string;
let originalTempDir: string | undefined;

beforeEach(async () => {
  sql.length = 0;
  ingested.length = 0;
  ledgerRows = [];
  dedupeEverything = false;
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'damc-manifest-'));
  originalDataDir = env.DATA_DIR;
  originalTempDir = env.DAMC_IMPORT_TEMP_DIR;
  (env as { DATA_DIR: string }).DATA_DIR = path.join(tempRoot, 'storage');
  (env as { DAMC_IMPORT_TEMP_DIR?: string }).DAMC_IMPORT_TEMP_DIR = path.join(tempRoot, 'tmp');
});

afterEach(async () => {
  (env as { DATA_DIR: string }).DATA_DIR = originalDataDir;
  (env as { DAMC_IMPORT_TEMP_DIR?: string }).DAMC_IMPORT_TEMP_DIR = originalTempDir;
  await fs.rm(tempRoot, { recursive: true, force: true });
});

/** The last stats object written to the job row. */
function finalStats(): Record<string, any> {
  const updates = sql.filter(s => /UPDATE sync_jobs SET status=\$1,finished_at/i.test(s.text));
  return JSON.parse(String(updates.at(-1)!.params[1]));
}

function finalStatus(): string {
  const updates = sql.filter(s => /UPDATE sync_jobs SET status=\$1,finished_at/i.test(s.text));
  return String(updates.at(-1)!.params[0]);
}

// ---------------------------------------------------------------------------

describe('M — conversations are imported through the existing streaming path', () => {
  it('imports every conversation in the conversations archive', async () => {
    const manifest = parseClaudeManifest(manifestJson());
    const result = await runManifestImportJob(USER, manifest, { fetchImpl: allSucceed(4) });

    expect(ingested).toEqual(['c0', 'c1', 'c2', 'c3']);
    expect(result.stats.imported).toBe(4);
    expect(result.stats.conversationsDetected).toBe(4);
    // Two messages per conversation in the fixture.
    expect(result.stats.messages).toBe(8);
    expect(result.stats.memoriesCreated).toBe(4);
    const conversations = result.stats.files.find(f => f.category === 'conversations')!;
    expect(conversations.status).toBe('imported');
    expect(conversations.conversations).toBe(4);
  });

  it('runs conversations first even though the manifest lists it last', async () => {
    const manifest = parseClaudeManifest(manifestJson());
    const order: string[] = [];
    const tracking: typeof fetch = (async (input: RequestInfo | URL) => {
      const href = String(input);
      order.push(href.split('/download/')[1]!.replace(/-\d+$/, ''));
      return allSucceed()(input as never);
    }) as typeof fetch;

    await runManifestImportJob(USER, manifest, { fetchImpl: tracking });
    // A single-use URL makes ordering matter: if a later download fails the user
    // should already have the part they came for.
    expect(order[0]).toBe('conversations');
  });
});

describe('N — a category with no observed structure is retained, not guessed at', () => {
  it('keeps the archive, records its real entries, and creates nothing from it', async () => {
    const manifest = parseClaudeManifest(manifestJson(['conversations', 'memories']));
    const result = await runManifestImportJob(USER, manifest, { fetchImpl: allSucceed(1) });

    const memories = result.stats.files.find(f => f.category === 'memories')!;
    expect(memories.status).toBe('retained');
    // The entry listing is the evidence a future parser gets written against.
    expect(memories.entryNames.sort()).toEqual(['memories/2026-01.json', 'memories/index.json']);
    expect(memories.entryCount).toBe(2);
    // Nothing was parsed out of it.
    expect(memories.conversations).toBeNull();
    expect(memories.imported).toBeNull();
    // Only the conversations archive produced ingest calls.
    expect(ingested).toEqual(['c0']);

    const kept = await fs.readdir(retainedArchiveDir(JOB));
    expect(kept).toContain('memories-000.zip');
  });

  it('does not lose a retained archive when the temp file is swept', async () => {
    const manifest = parseClaudeManifest(manifestJson(['memories']));
    const result = await runManifestImportJob(USER, manifest, { fetchImpl: allSucceed() });
    const kept = result.stats.files[0]!.retainedPath!;
    // Retention is a move out of the temp area; the file must still be readable
    // after the run, because the URL that produced it can never be used again.
    const stat = await fs.stat(kept);
    expect(stat.size).toBeGreaterThan(0);
  });
});

describe('O — one failing file does not take the rest down', () => {
  it('imports conversations even when another category 404s', async () => {
    const manifest = parseClaudeManifest(manifestJson(['conversations', 'projects']));
    const result = await runManifestImportJob(USER, manifest, {
      fetchImpl: fetchFor({
        conversations: () => zipResponse(conversationsZip(2)),
        projects: () => new Response(null, { status: 404 })
      })
    });

    expect(result.stats.files.find(f => f.category === 'conversations')!.status).toBe('imported');
    const projects = result.stats.files.find(f => f.category === 'projects')!;
    expect(projects.status).toBe('already_used');
    expect(projects.errorCode).toBe('DOWNLOAD_URL_CONSUMED');
    // Something landed and something did not: that is exactly 'partial'.
    expect(result.status).toBe('partial');
    expect(finalStatus()).toBe('partial');
    expect(ingested).toEqual(['c0', 'c1']);
  });

  it('reports failed when nothing landed at all', async () => {
    const manifest = parseClaudeManifest(manifestJson(['conversations']));
    const result = await runManifestImportJob(USER, manifest, {
      fetchImpl: fetchFor({ conversations: () => new Response(null, { status: 500 }) })
    });
    expect(result.status).toBe('failed');
    expect(result.stats.files[0]!.status).toBe('failed');
  });

  it('records a downloaded archive that turns out not to contain conversations', async () => {
    const manifest = parseClaudeManifest(manifestJson(['conversations']));
    const result = await runManifestImportJob(USER, manifest, {
      // A ZIP with no conversations.json in it: downloaded fine, unimportable.
      fetchImpl: fetchFor({ conversations: () => zipResponse(otherCategoryZip()) })
    });
    const file = result.stats.files[0]!;
    expect(file.status).toBe('failed');
    expect(file.errorCode).toBe('CONVERSATIONS_JSON_MISSING');
    // The download itself did happen, and the ledger must say so — the URL is spent.
    expect(result.stats.filesDownloaded).toBe(1);
  });
});

describe('P — a bot-protection challenge stops the run without spending what is left', () => {
  it('marks the challenge, skips the remaining files, and never fetches their URLs', async () => {
    const manifest = parseClaudeManifest(manifestJson());
    const fetched: string[] = [];
    const challenged: typeof fetch = (async (input: RequestInfo | URL) => {
      fetched.push(String(input));
      return new Response('<html>Just a moment...</html>', {
        status: 403, headers: { 'content-type': 'text/html', 'cf-mitigated': 'challenge' }
      });
    }) as typeof fetch;

    const result = await runManifestImportJob(USER, manifest, { fetchImpl: challenged });

    // Exactly one request: the first file. The other four URLs are still unused,
    // which is the only reason the user can still fetch them from a browser.
    expect(fetched).toHaveLength(1);
    expect(result.stats.blockedByChallenge).toBe(true);
    expect(result.stats.files[0]!.status).toBe('blocked');
    expect(result.stats.files.slice(1).every(f => f.status === 'skipped')).toBe(true);

    // Deliberately NOT 'failed'. Bot protection is a path that does not work with
    // another path still open: none of these links was spent, so the user can
    // download the packages in their own browser and DAMC will import them from the
    // watch folder. Calling it failed would tell them their export is gone when it
    // is not. 'awaiting_download' is also outside the ('running','queued') set that
    // boot reconciliation fails, so the job survives a container restart.
    expect(result.status).toBe('awaiting_download');
    expect(finalStatus()).toBe('awaiting_download');
  });

  it('says what to do instead, rather than blaming the link', async () => {
    const manifest = parseClaudeManifest(manifestJson(['conversations']));
    await runManifestImportJob(USER, manifest, {
      fetchImpl: fetchFor({ conversations: () => new Response('<html>challenge</html>', { status: 200, headers: { 'content-type': 'text/html' } }) })
    });
    const update = sql.filter(s => /UPDATE sync_jobs SET status=\$1,finished_at/i.test(s.text)).at(-1)!;
    const message = String(update.params[2]);
    // "Create a new export" would send the user round a loop that cannot end,
    // because the obstacle is not the link.
    expect(message).toMatch(/bot-protection challenge/);
    expect(message).toMatch(/browser/);
    expect(message).not.toMatch(/already been used/);
  });
});

describe('Q — a single-use URL is never fetched twice', () => {
  it('skips a URL the ledger already recorded as downloaded', async () => {
    const manifest = parseClaudeManifest(manifestJson(['conversations', 'memories']));
    ledgerRows = [{
      url_fingerprint: fingerprintUrl(manifest.files.find(f => f.category === 'memories')!.exportUrl),
      category: 'memories', filename: 'memories-000.zip', status: 'downloaded',
      bytes: '123', job_id: null, attempted_at: new Date('2026-09-01T00:00:00Z')
    }];

    const fetched: string[] = [];
    const tracking: typeof fetch = (async (input: RequestInfo | URL) => {
      fetched.push(String(input));
      return allSucceed(1)(input as never);
    }) as typeof fetch;

    const result = await runManifestImportJob(USER, manifest, { fetchImpl: tracking });

    expect(fetched.every(u => !u.includes('memories'))).toBe(true);
    const memories = result.stats.files.find(f => f.category === 'memories')!;
    expect(memories.status).toBe('already_used');
    expect(memories.errorMessage).toMatch(/already used/);
  });

  it('retries a URL whose previous attempt was only blocked', async () => {
    // A challenge never reached the file, so the URL is not spent and retrying is
    // the right behaviour — the opposite of the case above.
    const manifest = parseClaudeManifest(manifestJson(['conversations']));
    ledgerRows = [{
      url_fingerprint: fingerprintUrl(manifest.files[0]!.exportUrl),
      category: 'conversations', filename: 'conversations-000.zip', status: 'blocked',
      bytes: null, job_id: null, attempted_at: new Date('2026-09-01T00:00:00Z')
    }];
    const result = await runManifestImportJob(USER, manifest, { fetchImpl: allSucceed(1) });
    expect(result.stats.files[0]!.status).toBe('imported');
  });

  it('writes every attempt to the ledger', async () => {
    const manifest = parseClaudeManifest(manifestJson(['conversations', 'memories']));
    await runManifestImportJob(USER, manifest, { fetchImpl: allSucceed(1) });
    const writes = sql.filter(s => /INSERT INTO claude_export_downloads/i.test(s.text));
    expect(writes).toHaveLength(2);
    // The URL itself is never stored — only a hash of it.
    for (const write of writes) {
      expect(write.params.some(p => typeof p === 'string' && p.includes('claude.ai'))).toBe(false);
      expect(String(write.params[1])).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe('R — re-running the same manifest is idempotent', () => {
  it('reports a second run of the same conversations as deduplicated, not imported', async () => {
    dedupeEverything = true;
    const manifest = parseClaudeManifest(manifestJson(['conversations']));
    const result = await runManifestImportJob(USER, manifest, { fetchImpl: allSucceed(3) });
    expect(result.stats.imported).toBe(0);
    expect(result.stats.deduplicated).toBe(3);
    expect(result.stats.conversationsDetected).toBe(3);
    // Still a success: the data is present, which is what the user asked about.
    expect(result.status).toBe('completed');
  });
});

describe('S — progress and stats', () => {
  it('reports mode, file counts and the current category', async () => {
    const manifest = parseClaudeManifest(manifestJson(['conversations', 'memories']));
    const result = await runManifestImportJob(USER, manifest, { fetchImpl: allSucceed(2) });

    expect(result.stats.mode).toBe('manifest');
    expect(result.stats.totalFiles).toBe(2);
    expect(result.stats.filesDownloaded).toBe(2);
    expect(result.stats.filesImported).toBe(1);
    expect(result.stats.downloadedBytes).toBeGreaterThan(0);
    // Cleared when the run ends: a finished job has no current category.
    expect(result.stats.currentCategory).toBeNull();
  });

  it('publishes downloading and importing phases while running', async () => {
    const manifest = parseClaudeManifest(manifestJson(['conversations']));
    await runManifestImportJob(USER, manifest, { fetchImpl: allSucceed(2) });
    const progressWrites = sql
      .filter(s => /jsonb_build_object\('progress'/i.test(s.text))
      .map(s => JSON.parse(String(s.params[1])));
    const phases = progressWrites.map(p => p.phase);
    expect(phases).toContain('queued');
    expect(phases).toContain('downloading');
    expect(phases).toContain('importing');
    // The manifest fields ride along on the persisted progress.
    expect(progressWrites.at(-1)!.mode).toBe('manifest');
    expect(progressWrites.at(-1)!.totalFiles).toBe(1);
  });

  it('merges stats onto the job row rather than replacing it', async () => {
    const manifest = parseClaudeManifest(manifestJson(['conversations']));
    await runManifestImportJob(USER, manifest, { fetchImpl: allSucceed(1) });
    // `||` merge, not `=`: persistProgress writes a `progress` key on the same
    // column and it must survive.
    const statWrites = sql.filter(s => /stats=COALESCE\(stats/i.test(s.text));
    expect(statWrites.length).toBeGreaterThan(0);
    expect(sql.some(s => /SET stats=\$1::jsonb WHERE/i.test(s.text))).toBe(false);
  });
});

describe('T — temp files are always cleaned up', () => {
  it('leaves nothing behind after a successful run', async () => {
    const manifest = parseClaudeManifest(manifestJson());
    await runManifestImportJob(USER, manifest, { fetchImpl: allSucceed(2) });
    const leftovers = await fs.readdir(path.join(tempRoot, 'tmp')).catch(() => []);
    expect(leftovers.filter(n => n.startsWith('claude-'))).toEqual([]);
    expect(leftovers.filter(n => n.startsWith('shard-'))).toEqual([]);
  });

  it('leaves nothing behind after a failed download', async () => {
    const manifest = parseClaudeManifest(manifestJson(['conversations']));
    await runManifestImportJob(USER, manifest, {
      fetchImpl: fetchFor({ conversations: () => new Response(null, { status: 500 }) })
    });
    const leftovers = await fs.readdir(path.join(tempRoot, 'tmp')).catch(() => []);
    expect(leftovers.filter(n => n.startsWith('claude-'))).toEqual([]);
  });

  it('leaves nothing behind after an unreadable archive', async () => {
    const manifest = parseClaudeManifest(manifestJson(['conversations']));
    await runManifestImportJob(USER, manifest, {
      fetchImpl: fetchFor({ conversations: () => zipResponse(otherCategoryZip()) })
    });
    const leftovers = await fs.readdir(path.join(tempRoot, 'tmp')).catch(() => []);
    expect(leftovers.filter(n => n.startsWith('claude-'))).toEqual([]);
  });
});

describe('U — sharded conversations across several manifest entries', () => {
  it('accumulates counters across two conversations archives', async () => {
    const manifest = parseClaudeManifest({
      version: '1.0', total_files: 2,
      data_files: [
        { category: 'conversations', part: 0, batch_index: 0, filename: 'conversations-000.zip', export_url: url('conversations-0') },
        { category: 'conversations', part: 1, batch_index: 0, filename: 'conversations-001.zip', export_url: url('conversations-1') }
      ]
    });
    let call = 0;
    const twoParts: typeof fetch = (async () => zipResponse(conversationsZip(2, call++ === 0 ? 'a' : 'b'))) as typeof fetch;

    const result = await runManifestImportJob(USER, manifest, { fetchImpl: twoParts });

    expect(ingested).toEqual(['a0', 'a1', 'b0', 'b1']);
    expect(result.stats.imported).toBe(4);
    expect(result.stats.filesImported).toBe(2);
    expect(result.stats.files.every(f => f.conversations === 2)).toBe(true);
  });
});

describe('V — a filename from the manifest is never treated as a path', () => {
  it('strips directory separators before retaining an archive', async () => {
    const manifest = parseClaudeManifest({
      version: '1.0', total_files: 1,
      data_files: [{ category: 'memories', filename: '../../escaped.zip', export_url: url('memories-0') }]
    });
    const result = await runManifestImportJob(USER, manifest, { fetchImpl: allSucceed() });
    const kept = result.stats.files[0]!.retainedPath!;
    // Inside the job's own directory, whatever the manifest called the file.
    expect(path.dirname(path.resolve(kept))).toBe(path.resolve(retainedArchiveDir(JOB)));
    expect(path.basename(kept)).not.toContain('..');
  });
});

describe('Y — a re-run where every link is already spent reads as partial, not broken', () => {
  it('does not report failure when the only obstacle is that the links were used', async () => {
    const manifest = parseClaudeManifest(manifestJson(['conversations', 'memories']));
    ledgerRows = manifest.files.map(f => ({
      url_fingerprint: fingerprintUrl(f.exportUrl),
      category: f.category, filename: f.filename, status: 'downloaded',
      bytes: '1', job_id: null, attempted_at: new Date('2026-09-01T00:00:00Z')
    }));

    const fetched: string[] = [];
    const tracking: typeof fetch = (async (input: RequestInfo | URL) => {
      fetched.push(String(input));
      return allSucceed(1)(input as never);
    }) as typeof fetch;

    const result = await runManifestImportJob(USER, manifest, { fetchImpl: tracking });

    // Nothing was fetched, and nothing is wrong with DAMC — the links are gone.
    // 'failed' would be a lie about what happened.
    expect(fetched).toEqual([]);
    expect(result.status).toBe('partial');
    expect(result.stats.files.every(f => f.status === 'already_used')).toBe(true);
  });
});

describe('Z — nothing about the URLs reaches the job row', () => {
  it('records no export_url in stats, progress or the error message', async () => {
    const manifest = parseClaudeManifest(manifestJson());
    await runManifestImportJob(USER, manifest, { fetchImpl: allSucceed(2) });
    // Every parameter of every statement: an export_url on a job row is a live
    // credential that anyone who can read the import history would then hold.
    const serialized = JSON.stringify(sql.map(s => s.params));
    expect(serialized).not.toContain('claude.ai');
    expect(serialized).not.toContain('/download/');
  });

  it('keeps the URL out of a failure message too', async () => {
    const manifest = parseClaudeManifest(manifestJson(['conversations']));
    await runManifestImportJob(USER, manifest, {
      fetchImpl: fetchFor({ conversations: () => new Response(null, { status: 500 }) })
    });
    const stats = finalStats();
    // The downloader's own message names a masked URL; the mask must hold.
    expect(JSON.stringify(stats)).not.toContain('/download/conversations-0');
    expect(stats.files[0].errorMessage).toMatch(/…/);
  });
});
