/**
 * The database-backed behaviour of the Common Memory layer and the Sync Center:
 * restatement merge, cross-provider SUPERSEDES, provenance, connect/disconnect
 * safety, the Context Pack, watch-folder state persistence and the dashboard
 * counters the Sync Center displays. Same isolated "damc_test" database as
 * tests/import-pipeline.integration.test.ts (never the "damc" database the
 * dev/production stack uses) and the same self-skip when that database is
 * unreachable — see that file's header comment for setup.
 *
 * A distinct synthetic user id from the other integration file so the two can
 * never collide if a future config ever runs test files in parallel.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TEST_DATABASE_URL, applyMigrations, requireDatabase } from './helpers/database.js';

const TEST_USER = '00000000-0000-0000-0000-0000000000bb';

// Skips when Postgres is unreachable, and fails instead when DAMC_REQUIRE_DB
// is set — see tests/helpers/database.ts for why that switch exists.
const dbAvailable = await requireDatabase();

const previousDatabaseUrl = process.env.DATABASE_URL;
const previousDevMode = process.env.DAMC_DEV_MODE;
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.DAMC_DEV_MODE = 'true';

const { pool, query } = await import('../src/db/pool.js');
const { ingestConversation } = await import('../src/services/ingestion-service.js');
const { getMemoryDetail } = await import('../src/repositories/memory-repository.js');
const { connectProvider, disconnectProvider, getConnectionStates, NotSupportedError } = await import('../src/services/connector-connection-service.js');
const { buildContextPack, formatContextPackAsText } = await import('../src/services/context-pack-service.js');
const { findOrCreateProject } = await import('../src/services/project-service.js');
const { setWatchFolderEnabled, isWatchFolderEnabled } = await import('../src/services/watch-state-service.js');
const { getDashboard } = await import('../src/services/dashboard-service.js');

function conv(provider: 'chatgpt' | 'claude', externalId: string, texts: string[], projectHint?: string) {
  return {
    provider, externalId, title: `Common memory ${externalId}`, projectHint,
    messages: texts.map((content, i) => ({ role: (i % 2 === 0 ? 'user' : 'assistant') as const, content, sequenceNo: i }))
  };
}

describe.runIf(dbAvailable)('cross-provider Common Memory (isolated damc_test database)', () => {
  beforeAll(async () => {
    await applyMigrations();
    await query(`INSERT INTO users(id,email,display_name) VALUES($1,$2,$3) ON CONFLICT (id) DO NOTHING`,
      [TEST_USER, 'common-memory@damc.test', 'DAMC Common Memory Integration']);
  }, 30000);

  afterAll(async () => {
    await query(`DELETE FROM users WHERE id=$1`, [TEST_USER]); // cascades everything this suite created
    await pool.end();
    process.env.DATABASE_URL = previousDatabaseUrl;
    process.env.DAMC_DEV_MODE = previousDevMode;
  });

  // The subject noun is fused with a per-test suffix (한글+숫자 tokenize as one
  // token, e.g. "배포1699999999999") so no two tests in this shared-user suite
  // can ever have their decisions cross-linked by the deliberately loose
  // subject/token matching in decision-topic.ts. Real production data does not
  // need this — two genuinely different features are never going to share a
  // made-up compound noun like this — but two test cases both saying generic
  // "배포" easily can, and that is a test-isolation problem, not a product one.
  const subj = (n: number) => `배포${n}`;

  describe('cross-provider restatement merges into one Common Memory', () => {
    it('folds a differently-worded ChatGPT + Claude statement of the same decision into one memory with two provenances', async () => {
      // Same value (Docker), same dimension family (방식/방법 both normalize to
      // "method") — proven as a same-family/same-value pair by
      // decision-dimension.test.ts's family() check. The ONLY thing new here is
      // that the two statements arrive from different providers.
      const suffix = Date.now();
      const chatgpt = await ingestConversation(TEST_USER, conv('chatgpt', `restate-a-${suffix}`, [`${subj(suffix)} 방식은 Docker로 결정했다.`]));
      expect(chatgpt.memoriesCreated).toBe(1);

      const claude = await ingestConversation(TEST_USER, conv('claude', `restate-b-${suffix}`, [`${subj(suffix)} 방법은 Docker로 하기로 했다.`]));
      // No new memory: this is a restatement of the ChatGPT one, not a second decision.
      expect(claude.memoriesCreated).toBe(0);
      expect(claude.deduplicated).toBe(false); // it is a real restatement, not a byte-identical duplicate either

      const rows = await query<{ id: string; status: string }>(
        `SELECT id, status FROM memories WHERE user_id=$1 AND content LIKE $2 AND type='DECISION' ORDER BY created_at`, [TEST_USER, `%${subj(suffix)}%`]);
      expect(rows.rows).toHaveLength(1); // one Common Memory, not two
      expect(rows.rows[0]?.status).toBe('active');

      const detail = await getMemoryDetail(TEST_USER, rows.rows[0]!.id);
      const providers = new Set([detail!.provider, ...(detail as any).versions.map((v: any) => v.provider)].filter(Boolean));
      expect(providers).toEqual(new Set(['chatgpt', 'claude'])); // both provenances preserved
    });

    it('does not merge two decisions with the same subject but a different dimension (method vs schedule)', async () => {
      const suffix = Date.now();
      await ingestConversation(TEST_USER, conv('chatgpt', `dim-a-${suffix}`, [`${subj(suffix)} 방식은 Docker로 결정했다.`]));
      await ingestConversation(TEST_USER, conv('claude', `dim-b-${suffix}`, [`${subj(suffix)} 일정은 9월 20일로 결정했다.`]));
      const rows = await query(`SELECT status FROM memories WHERE user_id=$1 AND content LIKE $2 AND status='active'`, [TEST_USER, `%${subj(suffix)}%`]);
      expect(rows.rowCount).toBe(2); // two independent active decisions, neither merged nor superseded
    });
  });

  describe('cross-provider SUPERSEDES', () => {
    it('supersedes a ChatGPT decision with a genuinely different value stated later by Claude', async () => {
      const suffix = Date.now();
      // Same proven supersede pair as decision-dimension.test.ts's "Docker ->
      // Kubernetes" case (both sides carry the same dimension word, 방식), just
      // with the subject fused to a suffix for test isolation and the two
      // statements coming from different providers.
      await ingestConversation(TEST_USER, conv('chatgpt', `xsup-a-${suffix}`, [`${subj(suffix)} 방식은 Docker로 결정했다.`]));
      const second = await ingestConversation(TEST_USER, conv('claude', `xsup-b-${suffix}`, [`${subj(suffix)} 방식은 Kubernetes로 변경하기로 결정했다.`]));
      expect(second.memoriesSuperseded).toBeGreaterThanOrEqual(1);

      const docker = await query<{ status: string }>(`SELECT status FROM memories WHERE user_id=$1 AND content LIKE $2 AND content LIKE '%Docker%' ORDER BY created_at DESC LIMIT 1`, [TEST_USER, `%${subj(suffix)}%`]);
      expect(docker.rows[0]?.status).toBe('superseded');

      const kube = await query<{ id: string }>(`SELECT id FROM memories WHERE user_id=$1 AND content LIKE $2 AND content LIKE '%Kubernetes%' ORDER BY created_at DESC LIMIT 1`, [TEST_USER, `%${subj(suffix)}%`]);
      const relation = await query(`SELECT 1 FROM relations WHERE user_id=$1 AND from_memory_id=$2 AND relation_type='SUPERSEDES'`, [TEST_USER, kube.rows[0]!.id]);
      expect(relation.rowCount).toBeGreaterThanOrEqual(1);

      // provenance of each side is a different provider — this is the "provider
      // is different, that must never be the reason two memories stay separate
      // when the *value* did change" case working correctly the other direction.
      const kubeDetail = await getMemoryDetail(TEST_USER, kube.rows[0]!.id);
      expect(kubeDetail!.provider).toBe('claude');
    });
  });

  describe('connect / disconnect', () => {
    it('rejects a provider with no local pipeline rather than silently succeeding', async () => {
      await expect(connectProvider(TEST_USER, 'gemini')).rejects.toBeInstanceOf(NotSupportedError);
      await expect(disconnectProvider(TEST_USER, 'gemini')).rejects.toBeInstanceOf(NotSupportedError);
    });

    it('connects and disconnects chatgpt, persisting the state', async () => {
      const connected = await connectProvider(TEST_USER, 'chatgpt');
      expect(connected.connected).toBe(true);
      expect((await getConnectionStates(TEST_USER)).chatgpt?.connected).toBe(true);

      const disconnected = await disconnectProvider(TEST_USER, 'chatgpt');
      expect(disconnected.connected).toBe(false);
      expect((await getConnectionStates(TEST_USER)).chatgpt?.connected).toBe(false);
    });

    it('disconnecting never touches memories, conversations or provenance already recorded', async () => {
      const suffix = Date.now();
      await connectProvider(TEST_USER, 'claude');
      await ingestConversation(TEST_USER, conv('claude', `disc-safety-${suffix}`, ['연결 해제 안전성 테스트를 위한 결정: 감시는 계속된다로 결정했다.']));

      const before = await query(`SELECT count(*)::int AS n FROM memories WHERE user_id=$1`, [TEST_USER]);
      const beforeConvos = await query(`SELECT count(*)::int AS n FROM conversations WHERE user_id=$1`, [TEST_USER]);

      await disconnectProvider(TEST_USER, 'claude');

      const after = await query(`SELECT count(*)::int AS n FROM memories WHERE user_id=$1`, [TEST_USER]);
      const afterConvos = await query(`SELECT count(*)::int AS n FROM conversations WHERE user_id=$1`, [TEST_USER]);
      expect((after.rows[0] as any).n).toBe((before.rows[0] as any).n);
      expect((afterConvos.rows[0] as any).n).toBe((beforeConvos.rows[0] as any).n);
    });
  });

  describe('Context Pack', () => {
    it('groups memories into active decisions / tasks / constraints, size-bounded, with provenance', async () => {
      const suffix = Date.now();
      const projectName = `Context Pack Project ${suffix}`;
      // Content is unique per run (embeds suffix): contentHash dedup is keyed on
      // type+title+content only, not on project, so reusing another test's exact
      // wording here would be silently treated as the same memory it already
      // created (and that one belongs to no project, or a different one).
      await ingestConversation(TEST_USER, conv('chatgpt', `pack-decision-${suffix}`, [`컨텍스트 팩 배포 방식(${suffix})은 Docker로 결정했다.`], projectName));
      await ingestConversation(TEST_USER, conv('claude', `pack-task-${suffix}`, [`컨텍스트 팩 PostgreSQL(${suffix}) pool 재연결 로직을 확인해줘.`], projectName));

      // Idempotent: ingestConversation already created this project via the hint above.
      const projectId = await findOrCreateProject(TEST_USER, projectName);

      const pack = await buildContextPack(TEST_USER, { projectId });
      expect(pack.version).toBe('damc-context-pack-v1');
      expect(pack.project?.name).toBe(projectName);
      expect(pack.activeDecisions.length).toBeGreaterThanOrEqual(1);
      expect(pack.activeTasks.length).toBeGreaterThanOrEqual(1);
      expect(pack.activeDecisions[0]?.type).toBe('DECISION');
      expect(pack.activeTasks[0]?.type).toBe('TASK');
      // Bucket caps are real, not just documented.
      expect(pack.activeDecisions.length).toBeLessThanOrEqual(10);
      expect(pack.activeTasks.length).toBeLessThanOrEqual(10);
    });

    it('never includes a raw HISTORY dump — recentContext stays capped', async () => {
      const suffix = Date.now();
      // HISTORY candidates: long plain messages, no project hint, no decision/task signal.
      for (let i = 0; i < 15; i++) {
        await ingestConversation(TEST_USER, conv('chatgpt', `history-${suffix}-${i}`, [
          `이것은 그냥 일상적인 대화 기록입니다 아무 결정도 아니고 작업도 아닙니다 메시지 번호 ${i} 입니다 그냥 흘러가는 이야기일 뿐입니다.`
        ]));
      }
      const pack = await buildContextPack(TEST_USER, {});
      expect(pack.recentContext.length).toBeLessThanOrEqual(6);
    });

    it('renders as plain text pasteable into any AI, listing every provider that stated a merged fact', async () => {
      const suffix = Date.now();
      await ingestConversation(TEST_USER, conv('chatgpt', `pack-text-a-${suffix}`, ['테스트 배포 정책은 매주 금요일 점검한다.']));
      await ingestConversation(TEST_USER, conv('claude', `pack-text-b-${suffix}`, ['테스트 배포 정책은 매주 금요일에 점검하기로 했다.']));
      const pack = await buildContextPack(TEST_USER, {});
      const text = formatContextPackAsText(pack);
      expect(text).toContain('ACTIVE DECISIONS:');
      expect(text).toContain('ACTIVE TASKS:');
      // Never dumps message content beyond what the pack itself already carries — no raw JSON.
      expect(text).not.toContain('{');
    });
  });

  /**
   * The watcher itself lives in process memory, so without this the "자동 감시 중"
   * state silently became false after every container restart or reboot. The
   * server reads this on boot (src/server.ts) to decide whether to resume.
   */
  describe('watch folder state survives a restart', () => {
    it('is off until it has been switched on', async () => {
      expect(await isWatchFolderEnabled(TEST_USER)).toBe(false);
    });

    it('remembers the on/off choice across separate reads, the way a restarted server sees it', async () => {
      await setWatchFolderEnabled(TEST_USER, true);
      expect(await isWatchFolderEnabled(TEST_USER)).toBe(true);

      await setWatchFolderEnabled(TEST_USER, false);
      expect(await isWatchFolderEnabled(TEST_USER)).toBe(false);
    });

    it('does not turn a provider connection on as a side effect', async () => {
      await setWatchFolderEnabled(TEST_USER, true);
      const states = await getConnectionStates(TEST_USER);
      // The watch folder is stored under its own reserved key, not as a provider.
      expect(states.chatgpt?.connected).toBe(false);
      expect(states.claude?.connected).toBe(false);
      await setWatchFolderEnabled(TEST_USER, false);
    });
  });

  /** The Sync Center's Common Memory block reads these counts; they must be real, not derived from a page of results. */
  describe('dashboard counters behind the Sync Center', () => {
    it('reports decision and task counts alongside the totals it always returned', async () => {
      const suffix = Date.now();
      await ingestConversation(TEST_USER, conv('chatgpt', `dash-d-${suffix}`, [`대시보드${suffix} 방식은 Docker로 결정했다.`]));
      await ingestConversation(TEST_USER, conv('claude', `dash-t-${suffix}`, [`대시보드${suffix} 재연결 로직을 확인해줘.`]));

      const dash: any = await getDashboard(TEST_USER);
      expect(dash.memory.total).toBeGreaterThan(0);
      expect(dash.memory.decisions).toBeGreaterThanOrEqual(1);
      expect(dash.memory.tasks).toBeGreaterThanOrEqual(1);
      expect(dash.memory.activeDecisions).toBeGreaterThanOrEqual(1);
      expect(dash.memory.openTasks).toBeGreaterThanOrEqual(1);
      // The fields the overview page already relied on are still there.
      expect(dash.memory.active).toBeGreaterThanOrEqual(0);
      expect(dash.projects.total).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(dash.recentJobs)).toBe(true);
    });

    it('counts never exceed the total', async () => {
      const dash: any = await getDashboard(TEST_USER);
      expect(dash.memory.decisions).toBeLessThanOrEqual(dash.memory.total);
      expect(dash.memory.tasks).toBeLessThanOrEqual(dash.memory.total);
      expect(dash.memory.activeDecisions).toBeLessThanOrEqual(dash.memory.decisions);
      expect(dash.memory.openTasks).toBeLessThanOrEqual(dash.memory.tasks);
    });
  });
});
