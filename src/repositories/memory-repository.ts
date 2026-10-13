import { query, pool, type Queryable } from '../db/pool.js';
import type { MemoryStatus, MemoryType } from '../types/domain.js';

export interface StoredMemory {
  id: string;
  userId: string;
  projectId: string | null;
  type: MemoryType;
  title: string;
  content: string;
  summary: string | null;
  status: MemoryStatus;
  importance: number;
  confidence: number;
  sourceId: string | null;
  sourceMessageId: string | null;
  version: number;
  supersedesId: string | null;
  contentHash: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/**
 * Provenance columns joined onto every memory read.
 * These are additive: no previously returned field is removed or renamed.
 */
export const MEMORY_PROVENANCE_JOIN = `
  LEFT JOIN projects p ON p.id = m.project_id
  LEFT JOIN sources s ON s.id = m.source_id
  LEFT JOIN conversations cv ON cv.source_id = s.id AND cv.user_id = m.user_id`;

export const MEMORY_PROVENANCE_COLUMNS = `
  p.name AS "projectName", p.slug AS "projectSlug",
  s.provider AS "provider", s.source_type AS "sourceType",
  s.external_id AS "sourceExternalId", s.title AS "sourceTitle",
  cv.id AS "conversationId", cv.title AS "conversationTitle",
  cv.external_id AS "conversationExternalId"`;

const MEMORY_BASE_COLUMNS = `
  m.id, m.user_id AS "userId", m.project_id AS "projectId", m.type, m.title, m.content, m.summary,
  m.status, m.importance::float AS importance, m.confidence::float AS confidence,
  m.source_id AS "sourceId", m.source_message_id AS "sourceMessageId", m.version,
  m.supersedes_id AS "supersedesId", m.content_hash AS "contentHash", m.metadata,
  m.created_at AS "createdAt", m.updated_at AS "updatedAt"`;

export const MEMORY_READ_COLUMNS = `${MEMORY_BASE_COLUMNS},${MEMORY_PROVENANCE_COLUMNS}`;

/**
 * `exec` lets a caller run these writes inside its own transaction (see
 * withTransaction in db/pool.ts). It defaults to the pool, so every existing
 * caller keeps its previous one-statement-per-connection behaviour.
 */
export async function findMemoryByHash(userId: string, contentHash: string, exec: Queryable = pool) {
  const r = await exec.query<StoredMemory>(
    `SELECT ${MEMORY_BASE_COLUMNS} FROM memories m WHERE m.user_id=$1 AND m.content_hash=$2 LIMIT 1`, [userId, contentHash]);
  return r.rows[0] ?? null;
}

export async function createMemory(input: {
  userId: string; projectId?: string; type: MemoryType; title: string; content: string;
  summary?: string; status?: MemoryStatus; importance: number; confidence: number;
  sourceId?: string; sourceMessageId?: string; supersedesId?: string; contentHash: string;
  metadata?: Record<string, unknown>;
}, exec: Queryable = pool) {
  const r = await exec.query<StoredMemory>(
    `INSERT INTO memories (user_id, project_id, type, title, content, summary, status, importance, confidence,
      source_id, source_message_id, supersedes_id, content_hash, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING id, user_id AS "userId", project_id AS "projectId", type, title, content, summary, status,
      importance::float AS importance, confidence::float AS confidence,
      source_id AS "sourceId", source_message_id AS "sourceMessageId", version, supersedes_id AS "supersedesId",
      content_hash AS "contentHash", metadata, created_at AS "createdAt", updated_at AS "updatedAt"`,
    [input.userId, input.projectId ?? null, input.type, input.title, input.content, input.summary ?? null,
      input.status ?? 'candidate', input.importance, input.confidence, input.sourceId ?? null,
      input.sourceMessageId ?? null, input.supersedesId ?? null, input.contentHash, input.metadata ?? {}]);
  return r.rows[0]!;
}

const SORTS: Record<string, string> = {
  newest: 'm.updated_at DESC',
  importance: 'm.importance DESC, m.updated_at DESC',
  created: 'm.created_at DESC'
};

export async function listMemories(userId: string, opts: {
  projectId?: string; type?: MemoryType; status?: MemoryStatus; provider?: string;
  minImportance?: number; sort?: string; limit?: number;
} = {}) {
  const params: unknown[] = [userId];
  const where = ['m.user_id=$1'];
  if (opts.projectId) { params.push(opts.projectId); where.push(`m.project_id=$${params.length}`); }
  if (opts.type) { params.push(opts.type); where.push(`m.type=$${params.length}`); }
  if (opts.status) { params.push(opts.status); where.push(`m.status=$${params.length}`); }
  if (opts.provider) { params.push(opts.provider); where.push(`s.provider=$${params.length}`); }
  if (typeof opts.minImportance === 'number' && !Number.isNaN(opts.minImportance)) {
    params.push(opts.minImportance); where.push(`m.importance >= $${params.length}`);
  }
  const order = SORTS[opts.sort ?? ''] ?? 'm.importance DESC, m.updated_at DESC';
  params.push(Math.min(Math.max(opts.limit ?? 50, 1), 200));
  const r = await query<StoredMemory>(
    `SELECT ${MEMORY_READ_COLUMNS} FROM memories m ${MEMORY_PROVENANCE_JOIN}
     WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT $${params.length}`, params);
  return r.rows;
}

/** Full memory record with provenance, version history and both relation directions. */
export async function getMemoryDetail(userId: string, memoryId: string) {
  const memory = await query(
    `SELECT ${MEMORY_READ_COLUMNS}, m.valid_from AS "validFrom", m.valid_until AS "validUntil"
     FROM memories m ${MEMORY_PROVENANCE_JOIN}
     WHERE m.user_id=$1 AND m.id=$2 LIMIT 1`, [userId, memoryId]);
  if (!memory.rows[0]) return null;

  const [versions, outgoing, incoming, message] = await Promise.all([
    // Each version's provider is what makes a cross-provider restatement
    // visible: one memory, several versions, potentially several providers.
    query(`SELECT mv.version_no AS "versionNo", mv.content, mv.status, mv.change_reason AS "changeReason",
            mv.source_id AS "sourceId", s.provider AS "provider", mv.created_at AS "createdAt"
           FROM memory_versions mv LEFT JOIN sources s ON s.id = mv.source_id
           WHERE mv.memory_id=$1 ORDER BY mv.version_no DESC LIMIT 50`, [memoryId]),
    query(`SELECT r.relation_type AS "relationType", r.confidence::float AS confidence, r.metadata,
            tm.id, tm.title, tm.type, tm.status
           FROM relations r JOIN memories tm ON tm.id=r.to_memory_id
           WHERE r.user_id=$1 AND r.from_memory_id=$2 ORDER BY r.confidence DESC LIMIT 50`, [userId, memoryId]),
    query(`SELECT r.relation_type AS "relationType", r.confidence::float AS confidence, r.metadata,
            fm.id, fm.title, fm.type, fm.status
           FROM relations r JOIN memories fm ON fm.id=r.from_memory_id
           WHERE r.user_id=$1 AND r.to_memory_id=$2 ORDER BY r.confidence DESC LIMIT 50`, [userId, memoryId]),
    query(`SELECT msg.role, msg.sequence_no AS "sequenceNo", msg.sent_at AS "sentAt",
            left(msg.content, 2000) AS content
           FROM messages msg
           JOIN memories m ON m.source_message_id = msg.id
           WHERE m.id=$1 LIMIT 1`, [memoryId])
  ]);

  return {
    ...memory.rows[0],
    versions: versions.rows,
    relations: { outgoing: outgoing.rows, incoming: incoming.rows },
    sourceMessage: message.rows[0] ?? null
  };
}

/** Distinct providers that actually produced memories for this user. Drives the Memory filter. */
export async function listMemoryProviders(userId: string) {
  const r = await query<{ provider: string; total: number }>(
    `SELECT s.provider, count(*)::int AS total
     FROM memories m JOIN sources s ON s.id = m.source_id
     WHERE m.user_id=$1 GROUP BY s.provider ORDER BY total DESC`, [userId]);
  return r.rows;
}

export async function addVersion(memoryId: string, versionNo: number, content: string, status: string, changeReason?: string, sourceId?: string, exec: Queryable = pool) {
  await exec.query(`INSERT INTO memory_versions(memory_id, version_no, content, status, change_reason, source_id) VALUES($1,$2,$3,$4,$5,$6)`,
    [memoryId, versionNo, content, status, changeReason ?? null, sourceId ?? null]);
}
