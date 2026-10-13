/**
 * The streaming importer against a real database: idempotency, progress, and
 * what a restart leaves behind.
 *
 * These are the properties that cannot be checked without PostgreSQL, because
 * they are all about what the database remembers between attempts — which is
 * exactly where import correctness lives. Same isolated damc_test database and
 * self-skip policy as the other database-backed files (tests/helpers/database.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { TEST_DATABASE_URL, applyMigrations, requireDatabase } from './helpers/database.js';

const TEST_USER = '00000000-0000-0000-0000-0000000000dd';

const dbAvailable = await requireDatabase();

const previousDatabaseUrl = process.env.DATABASE_URL;
process.env.DATABASE_URL = TEST_DATABASE_URL;

const { pool, query } = await import('../src/db/pool.js');
const { env } = await import('../src/config/env.js');
const { runStreamingImportJob } = await import('../src/services/sync-service.js');
const { openExportSource } = await import('../src/services/import-stream-service.js');
const { failInterruptedImports, getProgress, listActiveProgress } = await import('../src/services/import-progress-service.js');

let tmpDir: string;

function conversation(id: string, text: string) {
  return {
    id,
    current_node: 'b',
    mapping: {
      root: { id: 'root', parent: null, message: null },
      a: { id: 'a', parent: 'root', message: { id: `${id}-a`, author: { role: 'user' }, content: { parts: [text] } } },
      b: { id: 'b', parent: 'a', message: { id: `${id}-b`, author: { role: 'assistant' }, content: { parts: ['알겠습니다.'] } } }
    }
  };
}

async function writeExport(name: string, conversations: unknown[]): Promise<string> {
  const file = path.join(tmpDir, name);
  await fs.writeFile(file, JSON.stringify(conversations));
  return file;
}

/** Import a file the way the upload route does. */
async function importFile(file: string, fileName = path.basename(file)) {
  const source = await openExportSource(file);
  try {
    return await runStreamingImportJob(TEST_USER, 'chatgpt', () => source.conversations('chatgpt'), { source: 'web', fileName });
  } finally {
    await source.dispose();
  }
}

describe.runIf(dbAvailable)('streaming import against PostgreSQL (isolated damc_test database)', () => {
  beforeAll(async () => {
    await applyMigrations();
    await query(`INSERT INTO users(id,email,display_name) VALUES($1,'large-import@damc.test','DAMC Large Import') ON CONFLICT (id) DO NOTHING`, [TEST_USER]);
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'damc-large-'));
    env.DAMC_IMPORT_TEMP_DIR = path.join(tmpDir, 'work');
  }, 60000);

  afterAll(async () => {
    await query(`DELETE FROM users WHERE id=$1`, [TEST_USER]); // cascades everything this suite created
    await pool.end();
    await fs.rm(tmpDir, { recursive: true, force: true });
    process.env.DATABASE_URL = previousDatabaseUrl;
  });

  it('imports a streamed export end to end and records the job', async () => {
    const suffix = `basic-${Date.now()}`;
    const file = await writeExport(`${suffix}.json`, [
      conversation(`${suffix}-1`, `${suffix} 배포 방식은 Docker로 결정했다.`),
      conversation(`${suffix}-2`, `${suffix} PostgreSQL pool 재연결 로직을 확인해줘.`)
    ]);
    const result: any = await importFile(file);

    expect(result.status).toBe('completed');
    expect(result.imported).toBe(2);
    expect(result.conversationsDetected).toBe(2);
    expect(result.decisionCount).toBeGreaterThanOrEqual(1);
    expect(result.taskCount).toBeGreaterThanOrEqual(1);

    const job = await query<{ status: string; stats: any }>(`SELECT status, stats FROM sync_jobs WHERE id=$1`, [result.jobId]);
    expect(job.rows[0]?.status).toBe('completed');
    expect(job.rows[0]?.stats?.source).toBe('web');
    expect(job.rows[0]?.stats?.fileName).toBe(`${suffix}.json`);
  });

  /**
   * Requirement H / 9. Nothing about batching changes idempotency, and this is
   * what proves it: the same file imported twice writes one set of rows, because
   * conversations dedupe on (user_id, provider, external_id) inside
   * ingestConversation. A retry after a failure is therefore always safe.
   */
  it('re-importing the same export imports nothing twice', async () => {
    const suffix = `dedupe-${Date.now()}`;
    const file = await writeExport(`${suffix}.json`, [
      conversation(`${suffix}-1`, `${suffix} 로그 보관 기간은 90일로 결정했다.`),
      conversation(`${suffix}-2`, `${suffix} 캐시 전략은 Redis로 결정했다.`)
    ]);

    const first: any = await importFile(file);
    expect(first.imported).toBe(2);
    expect(first.deduplicated).toBe(0);

    const countAfterFirst = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM conversations WHERE user_id=$1 AND external_id LIKE $2`, [TEST_USER, `${suffix}%`]);
    const memoriesAfterFirst = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM memories WHERE user_id=$1 AND content LIKE $2`, [TEST_USER, `%${suffix}%`]);

    const second: any = await importFile(file);
    expect(second.imported).toBe(0);
    expect(second.deduplicated).toBe(2);

    const countAfterSecond = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM conversations WHERE user_id=$1 AND external_id LIKE $2`, [TEST_USER, `${suffix}%`]);
    const memoriesAfterSecond = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM memories WHERE user_id=$1 AND content LIKE $2`, [TEST_USER, `%${suffix}%`]);

    expect(countAfterSecond.rows[0]!.n).toBe(countAfterFirst.rows[0]!.n);
    expect(memoriesAfterSecond.rows[0]!.n).toBe(memoriesAfterFirst.rows[0]!.n);
  });

  /**
   * Requirement F. A read failure part-way through must keep what already
   * committed and report the cause — ingestConversation commits per conversation
   * on purpose, so a later failure cannot roll earlier work back.
   */
  it('keeps already-imported conversations when the export turns out to be truncated', async () => {
    const suffix = `truncated-${Date.now()}`;
    const whole = JSON.stringify([
      conversation(`${suffix}-1`, `${suffix} 인증 방식은 세션으로 결정했다.`),
      conversation(`${suffix}-2`, `${suffix} 백업 주기는 매일로 결정했다.`),
      conversation(`${suffix}-3`, `${suffix} 이 줄은 잘려나간다.`)
    ]);
    // Cut inside the third conversation, after the first two are complete.
    const cut = whole.lastIndexOf('{"id":"' + suffix + '-3');
    const file = path.join(tmpDir, `${suffix}.json`);
    await fs.writeFile(file, whole.slice(0, cut + 40));

    const error = await importFile(file).catch(e => e);
    expect(error).toBeInstanceOf(Error);

    // The two complete conversations landed.
    const stored = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM conversations WHERE user_id=$1 AND external_id LIKE $2`, [TEST_USER, `${suffix}%`]);
    expect(stored.rows[0]!.n).toBe(2);

    // And the job says so rather than claiming success.
    const job = await query<{ status: string; error_message: string | null; stats: any }>(
      `SELECT status, error_message, stats FROM sync_jobs WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`, [TEST_USER]);
    expect(job.rows[0]?.status).toBe('partial');
    expect(job.rows[0]?.error_message).toMatch(/truncated|Invalid JSON/i);
    expect(job.rows[0]?.stats?.imported).toBe(2);
  });

  /** Requirement 10: progress is recorded on the job row, batch by batch. */
  it('records progress on the job row as batches commit', async () => {
    const previousBatch = env.DAMC_IMPORT_BATCH_SIZE;
    env.DAMC_IMPORT_BATCH_SIZE = 2;
    try {
      const suffix = `progress-${Date.now()}`;
      const file = await writeExport(`${suffix}.json`, Array.from({ length: 7 }, (_, i) =>
        conversation(`${suffix}-${i}`, `${suffix} 항목 ${i} 기록용 대화 내용입니다 여기에 충분한 길이를 둡니다.`)));

      const result: any = await importFile(file);
      expect(result.conversationsDetected).toBe(7);

      const job = await query<{ stats: any }>(`SELECT stats FROM sync_jobs WHERE id=$1`, [result.jobId]);
      const progress = job.rows[0]?.stats?.progress;
      expect(progress).toBeTruthy();
      expect(progress.processed).toBe(7);
      expect(progress.imported).toBe(7);
      expect(progress.phase).toBe('finished');
      expect(progress.updatedAt).toBeTruthy();

      // The live registry is cleared once the import ends.
      expect(getProgress(result.jobId)).toBeNull();
      expect(listActiveProgress()).toEqual([]);
    } finally {
      env.DAMC_IMPORT_BATCH_SIZE = previousBatch;
    }
  });

  it('marks the job running while it streams, so progress is meaningful', async () => {
    const suffix = `running-${Date.now()}`;
    const file = await writeExport(`${suffix}.json`, [conversation(`${suffix}-1`, `${suffix} 상태 확인용 대화 내용입니다.`)]);

    let observedStatus: string | null = null;
    let observedProgress: unknown = null;
    const source = await openExportSource(file);
    try {
      await runStreamingImportJob(TEST_USER, 'chatgpt', async function* () {
        // Peek at the job row from inside the import.
        for await (const c of source.conversations('chatgpt')) {
          const row = await query<{ id: string; status: string }>(
            `SELECT id, status FROM sync_jobs WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`, [TEST_USER]);
          observedStatus = row.rows[0]!.status;
          observedProgress = getProgress(row.rows[0]!.id);
          yield c;
        }
      }, { source: 'web', fileName: `${suffix}.json` });
    } finally {
      await source.dispose();
    }

    expect(observedStatus).toBe('running');
    expect(observedProgress).toBeTruthy();
  });

  /**
   * Requirement G. An import killed by a restart leaves its row in 'running'
   * forever; boot reconciliation turns that into a failure with an instruction,
   * which is honest because re-running is safe (see the dedup test above).
   */
  it('marks an import interrupted by a restart as failed, with a re-run instruction', async () => {
    const orphan = await query<{ id: string }>(
      `INSERT INTO sync_jobs(user_id,connector,direction,status,started_at,attempts) VALUES($1,'chatgpt','inbound','running',now(),0) RETURNING id`,
      [TEST_USER]);
    const orphanId = orphan.rows[0]!.id;

    const reconciled = await failInterruptedImports();
    expect(reconciled).toBeGreaterThanOrEqual(1);

    const row = await query<{ status: string; error_message: string | null; finished_at: string | null }>(
      `SELECT status, error_message, finished_at FROM sync_jobs WHERE id=$1`, [orphanId]);
    expect(row.rows[0]?.status).toBe('failed');
    expect(row.rows[0]?.error_message).toMatch(/Interrupted by a server restart/);
    expect(row.rows[0]?.finished_at).not.toBeNull();
  });

  it('leaves finished jobs alone when reconciling', async () => {
    const done = await query<{ id: string }>(
      `INSERT INTO sync_jobs(user_id,connector,direction,status,started_at,finished_at,attempts) VALUES($1,'chatgpt','inbound','completed',now(),now(),0) RETURNING id`,
      [TEST_USER]);
    await failInterruptedImports();
    const row = await query<{ status: string }>(`SELECT status FROM sync_jobs WHERE id=$1`, [done.rows[0]!.id]);
    expect(row.rows[0]?.status).toBe('completed');
  });

  /** Requirement I: the rows a streamed import writes are the same as any other. */
  it('writes the same provenance a normal import does', async () => {
    const suffix = `provenance-${Date.now()}`;
    const file = await writeExport(`${suffix}.json`, [conversation(`${suffix}-1`, `${suffix} 배포 방식은 Kubernetes로 결정했다.`)]);
    await importFile(file);

    const row = await query<{ provider: string; status: string; type: string; source_type: string }>(
      `SELECT s.provider, m.status, m.type, s.source_type
         FROM memories m JOIN sources s ON s.id = m.source_id
        WHERE m.user_id=$1 AND m.content LIKE $2 ORDER BY m.created_at DESC LIMIT 1`,
      [TEST_USER, `%${suffix}%`]);
    expect(row.rows[0]?.provider).toBe('chatgpt');
    expect(row.rows[0]?.source_type).toBe('conversation');
    expect(row.rows[0]?.type).toBe('DECISION');
    expect(row.rows[0]?.status).toBe('active');

    const conv = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM messages msg JOIN conversations c ON c.id = msg.conversation_id
        WHERE c.user_id=$1 AND c.external_id=$2`, [TEST_USER, `${suffix}-1`]);
    expect(conv.rows[0]!.n).toBe(2);
  });

  /**
   * Requirements H / I / J for the sharded layout, against the real database: a
   * split export imports, records its shard count, and re-imports as a no-op.
   */
  it('imports a sharded ZIP, records the shard count, and stays idempotent', async () => {
    const suffix = `shards-${Date.now()}`;
    const zipPath = path.join(tmpDir, `${suffix}.zip`);
    const shard = (ids: string[]) => strToU8(JSON.stringify(ids.map(id => conversation(id, `${id} 배포 방식은 Docker로 결정했다.`))));
    const dat: Record<string, Uint8Array> = {};
    for (let i = 0; i < 30; i++) dat[`file-${suffix}-${i}.dat`] = strToU8('attachment payload '.repeat(20));
    await fs.writeFile(zipPath, zipSync({
      'chat.html': strToU8('<html></html>'),
      'shared_conversations.json': strToU8('[]'),
      'conversation_asset_file_names.json': strToU8('{}'),
      'conversations-002.json': shard([`${suffix}-e`]),
      'conversations-000.json': shard([`${suffix}-a`, `${suffix}-b`]),
      'conversations-001.json': shard([`${suffix}-c`, `${suffix}-d`]),
      ...dat
    }));

    const source = await openExportSource(zipPath);
    let result: any;
    try {
      expect(source.info.layout).toBe('sharded');
      expect(source.info.shardCount).toBe(3);
      expect(source.info.shardNames).toEqual(['conversations-000.json', 'conversations-001.json', 'conversations-002.json']);
      result = await runStreamingImportJob(TEST_USER, 'chatgpt', report => source.conversations('chatgpt', report), { source: 'web', fileName: `${suffix}.zip` });
    } finally {
      await source.dispose();
    }

    expect(result.status).toBe('completed');
    expect(result.imported).toBe(5);
    expect(result.conversationsDetected).toBe(5);
    expect(result.shardCount).toBe(3);

    // Requirement 18: the shard count is on the job row, not just the response.
    const job = await query<{ stats: any }>(`SELECT stats FROM sync_jobs WHERE id=$1`, [result.jobId]);
    expect(job.rows[0]?.stats?.shardCount).toBe(3);
    expect(job.rows[0]?.stats?.shardNames).toEqual(['conversations-000.json', 'conversations-001.json', 'conversations-002.json']);
    // Requirement 17: progress reached the last shard.
    expect(job.rows[0]?.stats?.progress?.shardsTotal).toBe(3);
    expect(job.rows[0]?.stats?.progress?.shardsProcessed).toBe(3);

    // All five conversations across the three shards landed, in one set.
    const stored = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM conversations WHERE user_id=$1 AND external_id LIKE $2`, [TEST_USER, `${suffix}-%`]);
    expect(stored.rows[0]!.n).toBe(5);

    // Requirement H: re-importing the same sharded archive writes nothing new.
    const again = await openExportSource(zipPath);
    let second: any;
    try {
      second = await runStreamingImportJob(TEST_USER, 'chatgpt', report => again.conversations('chatgpt', report), { source: 'web', fileName: `${suffix}.zip` });
    } finally {
      await again.dispose();
    }
    expect(second.imported).toBe(0);
    expect(second.deduplicated).toBe(5);
    expect(second.shardCount).toBe(3);
  });

  it('imports a ZIP through the same path', async () => {
    const suffix = `zip-${Date.now()}`;
    const zipPath = path.join(tmpDir, `${suffix}.zip`);
    await fs.writeFile(zipPath, zipSync({
      'export/README.txt': strToU8('ignored'),
      'export/conversations.json': strToU8(JSON.stringify([conversation(`${suffix}-1`, `${suffix} 알림 방식은 이메일로 결정했다.`)]))
    }));

    const source = await openExportSource(zipPath);
    let result: any;
    try {
      expect(source.info.container).toBe('zip');
      expect(source.info.shardNames).toEqual(['export/conversations.json']);
      result = await runStreamingImportJob(TEST_USER, 'chatgpt', () => source.conversations('chatgpt'), { source: 'web', fileName: `${suffix}.zip` });
    } finally {
      await source.dispose();
    }
    expect(result.status).toBe('completed');
    expect(result.imported).toBe(1);
  });
});
