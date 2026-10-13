/**
 * End-to-end MCP tool tests — the new Hub write tools exercised through the
 * real JSON-RPC dispatch (handleMcpRequest), against the same isolated
 * "damc_test" database the other integration suites use, with the same
 * self-skip when that database is unreachable and the same cascade cleanup:
 * every row this suite creates hangs off one dedicated user id.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TEST_DATABASE_URL, applyMigrations, requireDatabase } from './helpers/database.js';

const TEST_USER = '00000000-0000-0000-0000-0000000000ce';
const OTHER_USER = '00000000-0000-0000-0000-0000000000cf';

// Skips when Postgres is unreachable, and fails instead when DAMC_REQUIRE_DB
// is set — see tests/helpers/database.ts for why that switch exists.
const dbAvailable = await requireDatabase();

const previousDatabaseUrl = process.env.DATABASE_URL;
process.env.DATABASE_URL = TEST_DATABASE_URL;

const { pool, query } = await import('../src/db/pool.js');
const { handleMcpRequest } = await import('../src/connectors/mcp/server.js');

/** One JSON-RPC tools/call through the real dispatcher. Returns the structured payload. */
async function call(userId: string, name: string, args: Record<string, unknown>, clientId = 'claude-code') {
  const response: any = await handleMcpRequest(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    { userId, headers: { 'x-damc-client': clientId } }
  );
  if (response?.error) throw new Error(`tools/call ${name} failed: ${response.error.message}`);
  return response.result.structuredContent;
}

describe.runIf(dbAvailable)('MCP hub tools (isolated damc_test database)', () => {
  beforeAll(async () => {
    await applyMigrations();
    await query(`INSERT INTO users(id,email,display_name) VALUES($1,'e2e-mcp@damc.test','DAMC MCP E2E') ON CONFLICT (id) DO NOTHING`, [TEST_USER]);
  }, 30000);

  afterAll(async () => {
    // Same cascade story as the other suites: users(id) owns every row below.
    await query(`DELETE FROM users WHERE id IN ($1,$2)`, [TEST_USER, OTHER_USER]);
    await pool.end();
    process.env.DATABASE_URL = previousDatabaseUrl;
  });

  it('decision_create stores an active DECISION', async () => {
    const r = await call(TEST_USER, 'decision_create', { content: '배포 방식은 Docker로 결정했다', project_hint: 'MCP E2E' });
    expect(r.stored).toBe(true);
    expect(r.action).toBe('CREATE');
    const rows = await query<{ type: string; status: string }>(
      `SELECT type, status FROM memories WHERE id=$1`, [r.memoryId]);
    expect(rows.rows[0]).toMatchObject({ type: 'DECISION', status: 'active' });
  });

  /**
   * Regression: session_start/session_context/session_save all take `project`
   * (not `project_hint`) — a client that just called session_start with
   * `{project: "X"}` naturally reuses the same key for decision_create /
   * task_create / memory_create. Before this fix that key was silently
   * dropped (unknown keys are stripped, not rejected) and the memory landed
   * with no project at all, with no error to say so. Verified live against a
   * running server before patching: exactly this call stored with
   * project_id NULL.
   */
  it('decision_create accepts `project` as well as `project_hint`', async () => {
    const r = await call(TEST_USER, 'decision_create', { content: '릴리스 채널은 stable로 결정했다', project: 'MCP E2E Alias' });
    expect(r.action).toBe('CREATE');
    const rows = await query<{ project_id: string | null; project_name: string | null }>(
      `SELECT m.project_id, p.name AS project_name FROM memories m LEFT JOIN projects p ON p.id = m.project_id WHERE m.id=$1`,
      [r.memoryId]);
    expect(rows.rows[0]?.project_id).not.toBeNull();
    expect(rows.rows[0]?.project_name).toBe('MCP E2E Alias');
  });

  it('task_create and memory_create also accept `project`', async () => {
    const task = await call(TEST_USER, 'task_create', { content: 'API 게이트웨이 문서화 작업을 진행해야 한다', project: 'MCP E2E Alias' });
    const taskRow = await query<{ project_id: string | null }>(`SELECT project_id FROM memories WHERE id=$1`, [task.memoryId]);
    expect(taskRow.rows[0]?.project_id).not.toBeNull();

    const mem = await call(TEST_USER, 'memory_create', { content: '이 프로젝트는 항상 격리된 damc_test 데이터베이스에서만 테스트를 실행한다는 사실을 기록해둔다.', project: 'MCP E2E Alias' });
    expect(mem.stored).toBe(true);
  });

  it('a changed decision on the same subject supersedes the old one', async () => {
    const first = await call(TEST_USER, 'decision_create', { content: '인증 방식은 세션으로 결정했다' });
    expect(first.action).toBe('CREATE');
    const second = await call(TEST_USER, 'decision_create', { content: '인증 방식은 JWT 기반으로 변경하기로 결정했다' }, 'cursor');
    expect(second.action).toBe('SUPERSEDE');
    expect(second.supersededMemoryId).toBe(first.memoryId);
    const old = await query<{ status: string }>(`SELECT status FROM memories WHERE id=$1`, [first.memoryId]);
    expect(old.rows[0]?.status).toBe('superseded');
  });

  it('the same decision from another client is a restatement, not a second memory', async () => {
    const existing = await query<{ id: string }>(
      `SELECT id FROM memories WHERE user_id=$1 AND type='DECISION' AND content LIKE '%배포 방식은 Docker%' LIMIT 1`, [TEST_USER]);
    const before = await query<{ n: string }>(`SELECT count(*)::text AS n FROM memories WHERE user_id=$1 AND type='DECISION'`, [TEST_USER]);
    // Different words, same fact — that is what a restatement is.
    const r = await call(TEST_USER, 'decision_create', { content: '배포는 Docker로 하기로 최종 결정했다' }, 'cursor');
    expect(r.action).toBe('RESTATE');
    expect(r.memoryId).toBe(existing.rows[0]!.id);
    const after = await query<{ n: string }>(`SELECT count(*)::text AS n FROM memories WHERE user_id=$1 AND type='DECISION'`, [TEST_USER]);
    expect(Number(after.rows[0]!.n)).toBe(Number(before.rows[0]!.n));
    // The restatement names the second client in version history — the engine
    // writes its own reason text, so match on the version's source provider.
    const versions = await query<{ provider: string | null }>(
      `SELECT s.provider FROM memory_versions mv JOIN sources s ON s.id=mv.source_id
       WHERE mv.memory_id=$1`, [existing.rows[0]!.id]);
    expect(versions.rows.map(v => v.provider)).toContain('cursor');
  });

  it('decision_update supersedes a specific decision explicitly', async () => {
    const created = await call(TEST_USER, 'decision_create', { content: '캐시 전략은 Redis로 결정했다' });
    const r = await call(TEST_USER, 'decision_update', { memory_id: created.memoryId, content: '캐시 전략은 Memcached로 교체했다', reason: '비용' }, 'cursor');
    expect(r.superseded).toBe(true);
    expect(r.previousMemoryId).toBe(created.memoryId);
    const rows = await query<{ status: string }>(
      `SELECT m.status FROM memories m WHERE m.supersedes_id=$1`, [created.memoryId]);
    expect(rows.rows[0]?.status).toBe('active');
  });

  it('memory_update rewrites content and keeps the old text as a version', async () => {
    const task = await call(TEST_USER, 'task_create', { content: 'MCP E2E: 관리자 대시보드 리포트 정리' });
    const r = await call(TEST_USER, 'memory_update', { memory_id: task.memoryId, content: 'MCP E2E: 관리자 대시보드 리포트 정리 및 배포', reason: '범위 확장' });
    expect(r.updated).toBe(true);
    const detail: any = await call(TEST_USER, 'memory_get', { memory_id: task.memoryId });
    expect(detail.memory.content).toContain('배포');
    expect(detail.memory.versions.some((v: any) => v.changeReason === '범위 확장')).toBe(true);
  });

  it('task_status changes are explicit and versioned', async () => {
    const task = await call(TEST_USER, 'task_create', { content: 'MCP E2E: 감시 폴더 문서화 작업' });
    const r = await call(TEST_USER, 'task_status', { memory_id: task.memoryId, status: 'active', reason: '착수' });
    expect(r.status).toBe('active');
  });

  it('session flow: start returns the pack, save stores/merges/rejects by policy', async () => {
    const start = await call(TEST_USER, 'session_start', { project: 'MCP E2E' });
    expect(start.session_id).toMatch(/^[0-9a-f]{32}$/);
    expect(start.context_pack.version).toBe('damc-context-pack-v1');
    expect(start.context_pack.activeDecisions.length).toBeGreaterThan(0);

    const saved = await call(TEST_USER, 'session_save', {
      session_id: start.session_id,
      items: [
        'MCP E2E 결정: 리포트 내보내기는 JSON 단일 포맷으로 확정했다.',
        { content: 'DATABASE_PASSWORD=sup3r-s3cret-value' },
        '확인 부탁'
      ]
    }, 'cursor');
    expect(saved.storedCount).toBe(1);
    expect(saved.rejectedCount).toBe(1);
    expect(saved.skippedCount).toBe(1);
    expect(saved.items[1]?.note).toContain('never stores credentials');
  });

  it('user isolation: another user\'s gateway sees nothing', async () => {
    await query(`INSERT INTO users(id,email,display_name) VALUES($1,'other-mcp@damc.test','Other') ON CONFLICT (id) DO NOTHING`, [OTHER_USER]);
    const search = await call(OTHER_USER, 'memory_search', { query: '배포' });
    expect(search.count).toBe(0);
    // session_start may create the other user's own empty project — the point
    // is that none of TEST_USER's memories leak into their pack.
    const session = await call(OTHER_USER, 'session_start', { project: 'MCP E2E' });
    expect(session.context_pack.activeDecisions.length).toBe(0);
    expect(session.context_pack.activeTasks.length).toBe(0);
    expect(session.context_pack.recentContext.length).toBe(0);
  });
});
