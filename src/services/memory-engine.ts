import { withTransaction } from '../db/pool.js';
import { sha256 } from '../lib/hash.js';
import { createMemory, findMemoryByHash, addVersion } from '../repositories/memory-repository.js';
import { extractDecisionSubject, linkDecisionSubjects, decidesDifferently, expandNeedles } from './decision-topic.js';
import { initialStatus, mayAutoSupersede, withholdReason } from './promotion-gate.js';
import type { MemoryCandidate, MemoryStatus } from '../types/domain.js';

export interface MemoryDecision {
  /**
   * `CONFLICT_PENDING` is a disagreement the promotion gate refused to resolve
   * automatically: the new statement contradicts a standing memory but was only
   * inferred, so both are kept and linked for review rather than one retiring
   * the other. See services/promotion-gate.ts.
   */
  action: 'CREATE' | 'SKIP_DUPLICATE' | 'SUPERSEDE' | 'RESTATE' | 'CONFLICT_PENDING';
  memoryId?: string;
  previousMemoryId?: string;
}

export async function upsertMemoryCandidate(input: {
  userId: string;
  projectId?: string;
  candidate: MemoryCandidate;
  sourceId?: string;
  sourceMessageId?: string;
}): Promise<MemoryDecision> {
  // One transaction for the whole decision. Supersession alone is four
  // statements (insert replacement, retire previous, version row, relation) and
  // a partial apply would leave either two contradictory active decisions or a
  // retired memory whose replacement nothing points at. See withTransaction.
  return withTransaction<MemoryDecision>(async tx => {
    const c = input.candidate;
    const gate = { type: c.type, confidence: c.confidence, evidence: c.evidence };
    const contentHash = sha256(`${c.type}\n${c.title}\n${c.content}`);
    const exact = await findMemoryByHash(input.userId, contentHash, tx);
    if (exact) return { action: 'SKIP_DUPLICATE', memoryId: exact.id };

    // Conservative conflict detection: only compare active decisions/rules/constraints
    // within the same project and never silently overwrite an existing memory.
    //
    // The candidate lookup is keyed on the *subject* of the decision, never on its
    // chosen value. Matching on the title (which begins with the content, and so
    // carries the value) meant "배포 방식은 Docker로 결정했다" and "배포 방식은
    // Kubernetes로 변경하기로 결정했다" never met, and both stayed active.
    if (['DECISION', 'RULE', 'CONSTRAINT'].includes(c.type)) {
      const subject = extractDecisionSubject(c.content);
      // Stage 1 — cheap SQL narrowing on subject words plus any value being replaced.
      // Needles expand through the bilingual alias table, so a Korean decision
      // still finds an English row about the same subject (and vice versa).
      const needles = [...new Set([...expandNeedles(subject.topicTokens), ...expandNeedles(subject.priorValueTokens)])].slice(0, 8);
      const related = needles.length
        ? await tx.query<{ id: string; content: string; version: number; status: string }>(
          `SELECT id, content, version, status FROM memories
           WHERE user_id=$1 AND type=$2 AND status IN ('active','confirmed')
             AND ($3::uuid IS NULL OR project_id=$3)
             AND (${needles.map((_, i) => `content ILIKE $${i + 4}`).join(' OR ')})
           ORDER BY updated_at DESC LIMIT 50`,
          [input.userId, c.type, input.projectId ?? null, ...needles.map(n => `%${n}%`)]
        )
        : { rows: [] as Array<{ id: string; content: string; version: number; status: string }> };

      // Same subject/dimension can mean two different things: the answer changed
      // (supersede) or it didn't (restatement — the same fact stated again, often
      // by a different provider in different words: "데이터베이스는 PostgreSQL로
      // 결정했다" and "PostgreSQL을 사용하기로 했다" are one Common Memory, not two).
      // A restatement never creates a second memory; it adds this source as
      // provenance on the one that already exists.
      let likelyConflict: typeof related.rows[number] | undefined;
      let restatementOf: typeof related.rows[number] | undefined;
      for (const r of related.rows) {
        const previous = extractDecisionSubject(r.content);
        // Same subject, or an explicit revision of the earlier value.
        if (!linkDecisionSubjects(previous, subject).linked) continue;
        // An identical statement is a restatement, never a conflict.
        if (normalize(r.content) === normalize(c.content)) { restatementOf = r; break; }
        // The answer must actually have changed to be a conflict. Comparing the
        // decided values directly survives heavy rewording, which raw token
        // overlap does not: "인증 방식은 세션으로 결정했다" and "앞으로 인증은 JWT
        // 기반으로 처리하기로 결정했다" share almost no surface tokens but clearly
        // settle the same subject differently. Restating the same value is not a
        // conflict — it is evidence for the same Common Memory.
        const changed = decidesDifferently(previous, subject);
        if (changed === true) { likelyConflict = r; break; }
        if (changed === false) { restatementOf = r; break; }
        // No comparable value on either side: fall back to the original semantic bar.
        if (overlap(normalize(r.content), normalize(c.content)) > 0.45) { restatementOf = r; break; }
      }

      if (likelyConflict) {
        // Retiring a standing decision is a stronger act than recording one, so
        // it needs the same evidence. An inferred extraction that disagrees with
        // something a person declared is recorded as a candidate and linked,
        // never allowed to retire it.
        if (!mayAutoSupersede(gate)) {
          const created = await createMemory({
            userId: input.userId, projectId: input.projectId, type: c.type, title: c.title,
            content: c.content, summary: c.summary, status: 'candidate', importance: c.importance,
            confidence: c.confidence, sourceId: input.sourceId, sourceMessageId: input.sourceMessageId,
            contentHash,
            metadata: { ...c.metadata, conflictResolution: 'pending_review', promotionWithheld: withholdReason(gate), conflictsWithMemoryId: likelyConflict.id }
          }, tx);
          await tx.query(
            `INSERT INTO relations(user_id,from_memory_id,to_memory_id,relation_type,confidence) VALUES($1,$2,$3,'CONFLICTS_WITH',$4) ON CONFLICT DO NOTHING`,
            [input.userId, created.id, likelyConflict.id, c.confidence]);
          return { action: 'CONFLICT_PENDING', memoryId: created.id, previousMemoryId: likelyConflict.id };
        }

        // The rows above were read without a lock, so re-read this one FOR
        // UPDATE and confirm it is still standing. Without this, two concurrent
        // writers could both supersede the same decision and produce two active
        // replacements. The lock holds until this transaction commits.
        const locked = await tx.query<{ id: string; content: string; version: number; status: string }>(
          `SELECT id, content, version, status FROM memories
           WHERE id=$1 AND user_id=$2 AND status IN ('active','confirmed') FOR UPDATE`,
          [likelyConflict.id, input.userId]);
        const previous = locked.rows[0];
        if (previous) {
          const created = await createMemory({
            userId: input.userId, projectId: input.projectId, type: c.type, title: c.title,
            content: c.content, summary: c.summary, status: 'active', importance: c.importance,
            confidence: c.confidence, sourceId: input.sourceId, sourceMessageId: input.sourceMessageId,
            supersedesId: previous.id, contentHash, metadata: { ...c.metadata, conflictResolution: 'supersedes_previous' }
          }, tx);
          // The UPDATE computes the next version number itself (version = version+1,
          // RETURNING it) rather than trusting the version read moments earlier —
          // this memory can be matched and revised more than once across its
          // lifetime, and a stale in-memory number would collide with
          // memory_versions' (memory_id, version_no) uniqueness on the second hit.
          const bumped = await tx.query<{ version: number }>(
            `UPDATE memories SET status='superseded', valid_until=now(), updated_at=now(), version=version+1 WHERE id=$1 RETURNING version`,
            [previous.id]);
          await addVersion(previous.id, bumped.rows[0]!.version, previous.content, 'superseded', 'Superseded by newer memory', input.sourceId, tx);
          await tx.query(`INSERT INTO relations(user_id,from_memory_id,to_memory_id,relation_type,confidence) VALUES($1,$2,$3,'SUPERSEDES',$4) ON CONFLICT DO NOTHING`,
            [input.userId, created.id, previous.id, c.confidence]);
          return { action: 'SUPERSEDE', memoryId: created.id, previousMemoryId: previous.id };
        }
        // Another writer retired it first; fall through and record this as a new memory.
      }

      if (restatementOf) {
        // No new memory row, no new relation — the existing Common Memory gains a
        // version recording who else said the same thing. getMemoryDetail already
        // returns memory_versions with each version's source, so this is what
        // makes a cross-provider merge visible (docs/COMMON_MEMORY_LAYER.md §9).
        // Same atomic version+1 as the supersede branch above, for the same reason.
        const bumped = await tx.query<{ version: number }>(
          `UPDATE memories SET updated_at=now(), version=version+1 WHERE id=$1 RETURNING version`, [restatementOf.id]);
        await addVersion(restatementOf.id, bumped.rows[0]!.version, c.content, restatementOf.status, 'Restated via another source', input.sourceId, tx);
        return { action: 'RESTATE', memoryId: restatementOf.id };
      }
    }

    const status = initialStatus(gate);
    const withheld = withholdReason(gate);
    const created = await createMemory({
      userId: input.userId, projectId: input.projectId, type: c.type, title: c.title,
      content: c.content, summary: c.summary, status,
      importance: c.importance, confidence: c.confidence, sourceId: input.sourceId,
      sourceMessageId: input.sourceMessageId, contentHash,
      // Only recorded when the gate actually withheld something a standing type
      // would otherwise have been promoted to, so a candidate's status is
      // explainable later without re-running the classifier.
      metadata: withheld && withheld !== 'type_not_standing' ? { ...c.metadata, promotionWithheld: withheld } : c.metadata
    }, tx);
    return { action: 'CREATE', memoryId: created.id };
  });
}

/**
 * Explicit supersession: an AI client names the exact memory it replaces
 * (decision_update), rather than relying on subject matching to find it. The
 * bookkeeping is identical to the conflict path in upsertMemoryCandidate —
 * new active memory with supersedes_id, old memory superseded with an
 * atomically bumped version, SUPERSEDES relation — so version history,
 * provenance and relation reads stay uniform no matter which path superseded
 * a memory.
 *
 * The gate does not apply here: the caller named the memory and asserted the
 * replacement, which is the most explicit evidence there is.
 */
export async function supersedeMemory(input: {
  userId: string;
  previousMemoryId: string;
  type: MemoryCandidate['type'];
  title: string;
  content: string;
  summary?: string;
  importance: number;
  confidence: number;
  sourceId?: string;
  sourceMessageId?: string;
  projectId?: string;
  reason?: string;
}): Promise<{ memoryId: string; previousMemoryId: string }> {
  return withTransaction(async tx => {
    // FOR UPDATE only holds a lock inside a transaction — outside one, Postgres
    // commits the single statement and releases it immediately.
    const previous = await tx.query<{ id: string; version: number; content: string; status: string; source_id: string | null }>(
      `SELECT id, version, content, status, source_id FROM memories WHERE id=$1 AND user_id=$2 FOR UPDATE`,
      [input.previousMemoryId, input.userId]);
    const row = previous.rows[0];
    if (!row) throw new Error('Memory not found');

    const contentHash = sha256(`${input.type}\n${input.title}\n${input.content}`);
    const created = await createMemory({
      userId: input.userId, projectId: input.projectId, type: input.type, title: input.title,
      content: input.content, summary: input.summary, status: 'active', importance: input.importance,
      confidence: input.confidence, sourceId: input.sourceId, sourceMessageId: input.sourceMessageId,
      supersedesId: row.id, contentHash,
      metadata: { conflictResolution: 'explicit_supersede', ...(input.reason ? { reason: input.reason } : {}) }
    }, tx);
    const bumped = await tx.query<{ version: number }>(
      `UPDATE memories SET status='superseded', valid_until=now(), updated_at=now(), version=version+1 WHERE id=$1 RETURNING version`,
      [row.id]);
    await addVersion(row.id, bumped.rows[0]!.version, row.content, 'superseded',
      input.reason ?? 'Superseded by newer memory', row.source_id ?? undefined, tx);
    await tx.query(`INSERT INTO relations(user_id,from_memory_id,to_memory_id,relation_type,confidence) VALUES($1,$2,$3,'SUPERSEDES',$4) ON CONFLICT DO NOTHING`,
      [input.userId, created.id, row.id, input.confidence]);
    return { memoryId: created.id, previousMemoryId: row.id };
  });
}

/**
 * Status changes are one transaction: the version number is read, written to
 * memories and written again into memory_versions, and those three must agree.
 * Two concurrent calls without the lock below would read the same version and
 * collide on memory_versions' (memory_id, version_no) uniqueness.
 */
export async function setMemoryStatus(userId: string, memoryId: string, status: MemoryStatus, reason?: string) {
  return withTransaction(async tx => {
    const current = await tx.query<{ id: string; version: number; content: string; status: string; source_id: string | null }>(
      `SELECT id, version, content, status, source_id FROM memories WHERE id=$1 AND user_id=$2 FOR UPDATE`, [memoryId, userId]);
    const row = current.rows[0];
    if (!row) throw new Error('Memory not found');
    const next = row.version + 1;
    await tx.query(`UPDATE memories SET status=$1, version=$2, updated_at=now() WHERE id=$3 AND user_id=$4`, [status, next, memoryId, userId]);
    await addVersion(memoryId, next, row.content, status, reason, row.source_id ?? undefined, tx);
    return { id: memoryId, status, version: next };
  });
}

function normalize(s: string) { return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); }
function overlap(a: string, b: string) {
  const A = new Set(a.split(/\s+/).filter(x => x.length > 2));
  const B = new Set(b.split(/\s+/).filter(x => x.length > 2));
  if (!A.size || !B.size) return 0;
  let common = 0; for (const x of A) if (B.has(x)) common++;
  return common / Math.min(A.size, B.size);
}
