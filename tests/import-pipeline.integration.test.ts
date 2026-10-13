/**
 * End-to-end import pipeline test — the piece the rest of the suite cannot
 * cover, because ingestConversation/runImportJob write to Postgres and every
 * other test file in this project is a pure unit test with no live database.
 *
 * Runs against an ISOLATED database ("damc_test"), never the "damc" database
 * used by the running dev/production stack. DATABASE_URL is overridden before
 * any src/ module is imported, so this file never opens a connection to
 * production data. Migrations are applied here (idempotently, same as
 * scripts/migrate.ts) so the suite is reproducible on a bare damc_test.
 *
 * Requires Postgres reachable at 127.0.0.1:5432 with a "damc_test" database
 * already created (CREATE DATABASE damc_test OWNER damc). If that database is
 * unreachable, every test in this file is skipped rather than failing the
 * whole suite — this mirrors db-pool.test.ts's stance that the rest of the
 * test run does not require a live database.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TEST_DATABASE_URL, applyMigrations, requireDatabase } from './helpers/database.js';

const TEST_USER = '00000000-0000-0000-0000-0000000000aa';

// Skips when Postgres is unreachable, and fails instead when DAMC_REQUIRE_DB
// is set — see tests/helpers/database.ts for why that switch exists.
const dbAvailable = await requireDatabase();

// Scoped to this file's module graph and restored below — never leaked to
// sibling test files, even if a future refactor makes them share a process.
const previousDatabaseUrl = process.env.DATABASE_URL;
const previousDevMode = process.env.DAMC_DEV_MODE;
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.DAMC_DEV_MODE = 'true';

const { pool, query } = await import('../src/db/pool.js');
const { ingestConversation } = await import('../src/services/ingestion-service.js');
const { runImportJob } = await import('../src/services/sync-service.js');

let messageSeq = 0;
function conv(provider: 'chatgpt' | 'claude', externalId: string, texts: string[]) {
  return {
    provider, externalId, title: `Integration ${externalId}`,
    messages: texts.map((content, i) => ({ role: (i % 2 === 0 ? 'user' : 'assistant') as const, content, sequenceNo: i })),
    metadata: { integrationTest: true }
  };
}

describe.runIf(dbAvailable)('import pipeline (isolated damc_test database)', () => {
  beforeAll(async () => {
    await applyMigrations();
    await query(`INSERT INTO users(id,email,display_name) VALUES($1,$2,$3) ON CONFLICT (id) DO NOTHING`,
      [TEST_USER, 'integration@damc.test', 'DAMC Import Integration']);
  }, 30000);

  afterAll(async () => {
    // users(id) cascades to every row this suite created (projects, sources,
    // conversations, messages, memories, memory_versions, relations,
    // sync_jobs) — see migrations/001_init.sql. Nothing outside TEST_USER is touched.
    await query(`DELETE FROM users WHERE id=$1`, [TEST_USER]);
    await pool.end();
    process.env.DATABASE_URL = previousDatabaseUrl;
    process.env.DAMC_DEV_MODE = previousDevMode;
  });

  it('extracts a Korean DECISION from a ChatGPT-shaped conversation and records provenance', async () => {
    const result = await ingestConversation(TEST_USER, conv('chatgpt', `decision-${Date.now()}`, [
      '배포 방식은 Docker로 결정했다.',
      '알겠습니다, 기록해두겠습니다.'
    ]));
    expect(result.deduplicated).toBe(false);
    expect(result.memoriesCreated).toBeGreaterThanOrEqual(1);

    const rows = await query<{ type: string; status: string; provider: string | null }>(
      `SELECT m.type, m.status, s.provider FROM memories m JOIN sources s ON s.id = m.source_id
       WHERE m.user_id=$1 AND m.content LIKE '%배포 방식은 Docker%' ORDER BY m.created_at DESC LIMIT 1`,
      [TEST_USER]
    );
    expect(rows.rows[0]?.type).toBe('DECISION');
    expect(rows.rows[0]?.status).toBe('active');
    expect(rows.rows[0]?.provider).toBe('chatgpt'); // provenance: which client/provider produced it
  });

  it('supersedes an earlier decision on the same dimension when the value changes', async () => {
    const topic = `supersede-${Date.now()}`;
    await ingestConversation(TEST_USER, conv('chatgpt', `${topic}-a`, ['배포 방식은 Docker로 결정했다.']));
    const second = await ingestConversation(TEST_USER, conv('chatgpt', `${topic}-b`, ['배포 방식은 Kubernetes로 변경하기로 결정했다.']));
    expect(second.memoriesSuperseded).toBeGreaterThanOrEqual(1);

    const superseded = await query<{ status: string }>(
      `SELECT status FROM memories WHERE user_id=$1 AND content LIKE '%배포 방식은 Docker%' ORDER BY created_at DESC LIMIT 1`,
      [TEST_USER]
    );
    expect(superseded.rows[0]?.status).toBe('superseded');

    const relation = await query(
      `SELECT 1 FROM relations WHERE user_id=$1 AND relation_type='SUPERSEDES' LIMIT 1`,
      [TEST_USER]
    );
    expect(relation.rowCount).toBeGreaterThanOrEqual(1);
  });

  it('extracts a Korean TASK from a Claude-shaped conversation', async () => {
    const result = await ingestConversation(TEST_USER, conv('claude', `task-${Date.now()}`, [
      'PostgreSQL pool 재연결 로직을 확인해줘.',
      '네, 확인하겠습니다.'
    ]));
    expect(result.memoriesCreated).toBeGreaterThanOrEqual(1);
    const rows = await query<{ type: string; status: string }>(
      `SELECT type, status FROM memories WHERE user_id=$1 AND content LIKE '%재연결 로직%' ORDER BY created_at DESC LIMIT 1`,
      [TEST_USER]
    );
    expect(rows.rows[0]?.type).toBe('TASK');
    expect(rows.rows[0]?.status).toBe('candidate'); // tasks are never auto-completed by an import
  });

  it('does not re-import the same export twice (duplicate memory / conversation dedup)', async () => {
    const externalId = `dup-${Date.now()}`;
    const conversation = conv('chatgpt', externalId, ['배포 정책은 매주 금요일 점검한다.']);
    const first = await ingestConversation(TEST_USER, conversation);
    const second = await ingestConversation(TEST_USER, conversation);
    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    expect(second.memoriesCreated).toBe(0);

    const count = await query(`SELECT count(*)::int AS n FROM conversations WHERE user_id=$1 AND external_id=$2`, [TEST_USER, externalId]);
    expect((count.rows[0] as any).n).toBe(1);
  });

  it('runImportJob completes a whole batch through the same pipeline and reports decision/task counts', async () => {
    const suffix = Date.now();
    const batch = [
      conv('chatgpt', `batch-a-${suffix}`, ['배포 일정은 9월 20일로 결정했다.']),
      conv('chatgpt', `batch-b-${suffix}`, ['PostgreSQL pool 재연결 로직을 확인해줘.'])
    ];
    const result: any = await runImportJob(TEST_USER, 'chatgpt', batch, { source: 'cli', fileName: 'integration.json' });
    expect(result.status).toBe('completed');
    expect(result.imported).toBe(2);
    expect(result.decisionCount).toBeGreaterThanOrEqual(1);
    expect(result.taskCount).toBeGreaterThanOrEqual(1);

    const job = await query<{ status: string; stats: any }>(`SELECT status, stats FROM sync_jobs WHERE id=$1`, [result.jobId]);
    expect(job.rows[0]?.status).toBe('completed');
    expect(job.rows[0]?.stats?.source).toBe('cli');
    expect(job.rows[0]?.stats?.fileName).toBe('integration.json');
  });

  it('runImportJob marks the job partial when one conversation in a batch is malformed, without losing the others', async () => {
    const suffix = Date.now();
    const good = conv('chatgpt', `partial-good-${suffix}`, ['배포 방식은 Docker로 결정했다.']);
    const broken = { provider: 'chatgpt', externalId: `partial-bad-${suffix}`, messages: null as any };
    const result: any = await runImportJob(TEST_USER, 'chatgpt', [good, broken], { source: 'web' });

    expect(result.status).toBe('partial');
    expect(result.imported).toBe(1);
    expect(result.errors).toHaveLength(1);

    const job = await query<{ status: string }>(`SELECT status FROM sync_jobs WHERE id=$1`, [result.jobId]);
    expect(job.rows[0]?.status).toBe('partial');
  });
});
