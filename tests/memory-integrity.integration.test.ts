/**
 * Integrity guarantees that only a real database can demonstrate: that a
 * multi-statement memory write is atomic, and that the promotion gate actually
 * protects standing memory inside the engine rather than only in isolation.
 *
 * Same isolated damc_test database, same self-skip policy and same cascade
 * cleanup as the other database-backed files — see tests/helpers/database.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TEST_DATABASE_URL, applyMigrations, requireDatabase } from './helpers/database.js';

const TEST_USER = '00000000-0000-0000-0000-0000000000cc';

const dbAvailable = await requireDatabase();

const previousDatabaseUrl = process.env.DATABASE_URL;
process.env.DATABASE_URL = TEST_DATABASE_URL;

const { pool, query, withTransaction } = await import('../src/db/pool.js');
const { upsertMemoryCandidate, supersedeMemory, setMemoryStatus } = await import('../src/services/memory-engine.js');

/** Fused subject+suffix so no two runs can cross-link through subject matching. */
const subj = (n: number) => `무결성${n}`;

function candidate(content: string, evidence: 'explicit' | 'inferred') {
  return {
    type: 'DECISION' as const,
    title: `DECISION: ${content.slice(0, 60)}`,
    content,
    summary: content.slice(0, 220),
    importance: 0.9,
    confidence: 0.55,
    evidence,
    metadata: { heuristic: true }
  };
}

describe.runIf(dbAvailable)('memory write integrity (isolated damc_test database)', () => {
  beforeAll(async () => {
    await applyMigrations();
    await query(`INSERT INTO users(id,email,display_name) VALUES($1,'integrity@damc.test','DAMC Integrity') ON CONFLICT (id) DO NOTHING`, [TEST_USER]);
  }, 30000);

  afterAll(async () => {
    await query(`DELETE FROM users WHERE id=$1`, [TEST_USER]); // cascades everything this suite created
    await pool.end();
    process.env.DATABASE_URL = previousDatabaseUrl;
  });

  describe('transaction atomicity', () => {
    it('rolls back every statement when the transaction body throws', async () => {
      const marker = `rollback-${Date.now()}`;
      await expect(withTransaction(async tx => {
        await tx.query(
          `INSERT INTO memories(user_id,type,title,content,content_hash) VALUES($1,'KNOWLEDGE',$2,$2,$3)`,
          [TEST_USER, marker, `hash-${marker}`]);
        // The row is visible inside the transaction...
        const inside = await tx.query(`SELECT 1 FROM memories WHERE user_id=$1 AND title=$2`, [TEST_USER, marker]);
        expect(inside.rowCount).toBe(1);
        throw new Error('boom');
      })).rejects.toThrow('boom');

      // ...and gone once it rolled back. Before withTransaction existed each
      // statement was its own autocommit, so this row would have survived.
      const after = await query(`SELECT 1 FROM memories WHERE user_id=$1 AND title=$2`, [TEST_USER, marker]);
      expect(after.rowCount).toBe(0);
    });

    it('commits the whole body on success', async () => {
      const marker = `commit-${Date.now()}`;
      await withTransaction(async tx => {
        await tx.query(
          `INSERT INTO memories(user_id,type,title,content,content_hash) VALUES($1,'KNOWLEDGE',$2,$2,$3)`,
          [TEST_USER, marker, `hash-${marker}`]);
      });
      const after = await query(`SELECT 1 FROM memories WHERE user_id=$1 AND title=$2`, [TEST_USER, marker]);
      expect(after.rowCount).toBe(1);
    });

    /**
     * Supersession writes four rows across three tables. This checks the set is
     * consistent after the fact: the replacement is active and points at the
     * previous memory, the previous one is superseded, it has a version row at
     * its new version number, and the SUPERSEDES relation exists.
     */
    it('leaves supersession fully consistent — replacement, retirement, version row and relation', async () => {
      const suffix = Date.now();
      const first = await upsertMemoryCandidate({
        userId: TEST_USER, candidate: candidate(`${subj(suffix)} 방식은 Docker로 결정했다.`, 'explicit')
      });
      expect(first.action).toBe('CREATE');

      const second = await supersedeMemory({
        userId: TEST_USER, previousMemoryId: first.memoryId!, type: 'DECISION',
        title: 'DECISION: replacement', content: `${subj(suffix)} 방식은 Kubernetes로 결정했다.`,
        importance: 0.9, confidence: 0.9, reason: '정합성 확인'
      });

      const previous = await query<{ status: string; version: number }>(
        `SELECT status, version FROM memories WHERE id=$1`, [first.memoryId]);
      expect(previous.rows[0]?.status).toBe('superseded');

      const replacement = await query<{ status: string; supersedes_id: string | null }>(
        `SELECT status, supersedes_id FROM memories WHERE id=$1`, [second.memoryId]);
      expect(replacement.rows[0]?.status).toBe('active');
      expect(replacement.rows[0]?.supersedes_id).toBe(first.memoryId);

      // The version row must exist at exactly the number the memory was bumped to.
      const version = await query(
        `SELECT 1 FROM memory_versions WHERE memory_id=$1 AND version_no=$2 AND status='superseded'`,
        [first.memoryId, previous.rows[0]!.version]);
      expect(version.rowCount).toBe(1);

      const relation = await query(
        `SELECT 1 FROM relations WHERE user_id=$1 AND from_memory_id=$2 AND to_memory_id=$3 AND relation_type='SUPERSEDES'`,
        [TEST_USER, second.memoryId, first.memoryId]);
      expect(relation.rowCount).toBe(1);
    });

    it('keeps status changes and their version rows in step', async () => {
      const suffix = Date.now();
      const created = await upsertMemoryCandidate({
        userId: TEST_USER, candidate: candidate(`${subj(suffix)} 상태 변경 대상은 확인 대기로 결정했다.`, 'explicit')
      });
      const before = await query<{ version: number }>(`SELECT version FROM memories WHERE id=$1`, [created.memoryId]);
      const result = await setMemoryStatus(TEST_USER, created.memoryId!, 'confirmed', '검토 완료');

      expect(result.version).toBe(before.rows[0]!.version + 1);
      const row = await query<{ status: string; version: number }>(`SELECT status, version FROM memories WHERE id=$1`, [created.memoryId]);
      expect(row.rows[0]?.status).toBe('confirmed');
      expect(row.rows[0]?.version).toBe(result.version);
      const version = await query(
        `SELECT 1 FROM memory_versions WHERE memory_id=$1 AND version_no=$2`, [created.memoryId, result.version]);
      expect(version.rowCount).toBe(1);
    });
  });

  describe('promotion gate inside the engine', () => {
    it('stores an inferred decision as a candidate, not as a standing fact', async () => {
      const suffix = Date.now();
      const result = await upsertMemoryCandidate({
        userId: TEST_USER, candidate: candidate(`${subj(suffix)} 방식은 Docker로 결정했다.`, 'inferred')
      });
      expect(result.action).toBe('CREATE');
      const row = await query<{ status: string; metadata: Record<string, unknown> }>(
        `SELECT status, metadata FROM memories WHERE id=$1`, [result.memoryId]);
      expect(row.rows[0]?.status).toBe('candidate');
      expect(row.rows[0]?.metadata?.promotionWithheld).toBe('inferred_evidence');
    });

    /**
     * The decisive test. This is the exact content pair the other suites prove
     * supersedes (Docker -> Kubernetes on the same 방식 dimension); the only
     * difference is that the second statement is graded inferred. So it isolates
     * the gate: the same words that legitimately retire a decision must not be
     * able to retire it when nobody actually declared them.
     */
    it('refuses to let an inferred contradiction retire a standing decision', async () => {
      const suffix = Date.now();
      const standing = await upsertMemoryCandidate({
        userId: TEST_USER, candidate: candidate(`${subj(suffix)} 방식은 Docker로 결정했다.`, 'explicit')
      });
      expect(standing.action).toBe('CREATE');

      const contradiction = await upsertMemoryCandidate({
        userId: TEST_USER, candidate: candidate(`${subj(suffix)} 방식은 Kubernetes로 변경하기로 결정했다.`, 'inferred')
      });
      expect(contradiction.action).toBe('CONFLICT_PENDING');
      expect(contradiction.previousMemoryId).toBe(standing.memoryId);

      // The declared decision is untouched: still active, still version 1.
      const original = await query<{ status: string; version: number; valid_until: string | null }>(
        `SELECT status, version, valid_until FROM memories WHERE id=$1`, [standing.memoryId]);
      expect(original.rows[0]?.status).toBe('active');
      expect(original.rows[0]?.version).toBe(1);
      expect(original.rows[0]?.valid_until).toBeNull();

      // The disagreement is recorded rather than discarded: a candidate, linked.
      const stored = await query<{ status: string; supersedes_id: string | null }>(
        `SELECT status, supersedes_id FROM memories WHERE id=$1`, [contradiction.memoryId]);
      expect(stored.rows[0]?.status).toBe('candidate');
      expect(stored.rows[0]?.supersedes_id).toBeNull();

      const conflict = await query(
        `SELECT 1 FROM relations WHERE user_id=$1 AND from_memory_id=$2 AND to_memory_id=$3 AND relation_type='CONFLICTS_WITH'`,
        [TEST_USER, contradiction.memoryId, standing.memoryId]);
      expect(conflict.rowCount).toBe(1);

      // And nothing was superseded anywhere in this subject.
      const superseded = await query(
        `SELECT 1 FROM relations WHERE user_id=$1 AND to_memory_id=$2 AND relation_type='SUPERSEDES'`,
        [TEST_USER, standing.memoryId]);
      expect(superseded.rowCount).toBe(0);
    });

    it('still supersedes when the same contradiction is explicitly declared', async () => {
      // The control for the test above: identical content, explicit evidence.
      const suffix = Date.now() + 1;
      const standing = await upsertMemoryCandidate({
        userId: TEST_USER, candidate: candidate(`${subj(suffix)} 방식은 Docker로 결정했다.`, 'explicit')
      });
      const replacement = await upsertMemoryCandidate({
        userId: TEST_USER, candidate: candidate(`${subj(suffix)} 방식은 Kubernetes로 변경하기로 결정했다.`, 'explicit')
      });
      expect(replacement.action).toBe('SUPERSEDE');
      expect(replacement.previousMemoryId).toBe(standing.memoryId);
      const original = await query<{ status: string }>(`SELECT status FROM memories WHERE id=$1`, [standing.memoryId]);
      expect(original.rows[0]?.status).toBe('superseded');
    });
  });
});
