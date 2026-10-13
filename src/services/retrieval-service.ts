import { query } from '../db/pool.js';
import { MEMORY_PROVENANCE_JOIN, MEMORY_PROVENANCE_COLUMNS } from '../repositories/memory-repository.js';

function tokenize(q: string): string[] { return q.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(x => x.length >= 2).slice(0, 20); }

const SEARCH_COLUMNS = `m.id, m.project_id AS "projectId", m.type, m.title, m.content, m.summary, m.status,
  m.importance::float AS importance, m.confidence::float AS confidence,
  m.source_id AS "sourceId", m.source_message_id AS "sourceMessageId", m.version, m.supersedes_id AS "supersedesId",
  m.created_at AS "createdAt", m.updated_at AS "updatedAt",${MEMORY_PROVENANCE_COLUMNS}`;

export interface SearchOptions {
  projectId?: string;
  status?: string;
  provider?: string;
  minImportance?: number;
  sort?: 'relevance' | 'newest' | 'importance' | string;
  limit?: number;
}

const RELEVANCE_ORDER = `(ts_rank_cd(m.search_vector, plainto_tsquery('simple',$2)) * 0.65 + m.importance * 0.20 + m.confidence * 0.10 + CASE WHEN m.status='active' THEN 0.05 ELSE 0 END) DESC, m.updated_at DESC`;

function orderFor(sort?: string) {
  if (sort === 'newest') return 'm.updated_at DESC';
  if (sort === 'importance') return 'm.importance DESC, m.updated_at DESC';
  return RELEVANCE_ORDER;
}

/** Shared filter builder: appends the caller's narrowing clauses to either query shape. */
function applyFilters(opts: SearchOptions, params: unknown[], clauses: string[]) {
  if (opts.projectId) { params.push(opts.projectId); clauses.push(`m.project_id=$${params.length}`); }
  if (opts.status) { params.push(opts.status); clauses.push(`m.status=$${params.length}`); }
  if (opts.provider) { params.push(opts.provider); clauses.push(`s.provider=$${params.length}`); }
  if (typeof opts.minImportance === 'number' && !Number.isNaN(opts.minImportance)) {
    params.push(opts.minImportance); clauses.push(`m.importance >= $${params.length}`);
  }
}

export async function searchMemories(userId: string, queryText: string, options: SearchOptions | string = {}, legacyLimit = 20) {
  // Backwards compatible: earlier callers passed (userId, q, projectId, limit).
  const opts: SearchOptions = typeof options === 'string' ? { projectId: options, limit: legacyLimit } : options;
  const limit = Math.min(Math.max(opts.limit ?? legacyLimit, 1), 100);
  const tokens = tokenize(queryText);
  if (!tokens.length) return [];

  const lexical = await lexicalSearch(userId, queryText, opts, limit);
  if (lexical.length >= limit) return lexical;

  // Substring search supplements — it does not merely rescue — lexical search.
  //
  // memories.search_vector is built with to_tsvector('simple', …), a
  // configuration that lowercases and splits on punctuation and performs no
  // morphology. Korean is agglutinative, so the particle fuses to the noun and
  // is indexed with it: "데이터베이스는" is one token, and the bare noun the user
  // typed ("데이터베이스") is neither a stem nor a prefix of it, so FTS misses it
  // entirely. Substring matching finds it.
  //
  // This now runs whenever lexical search *underfills* the limit, not only when
  // it returns nothing. Previously a single weak lexical hit was enough to
  // suppress the substring path completely, hiding every better Korean match
  // behind one incidental ASCII match.
  const seen = new Set(lexical.map(r => r.id));
  const merged = [...lexical];
  for (const row of await substringSearch(userId, tokens, opts, limit)) {
    if (seen.has(row.id)) continue;
    merged.push(row);
    if (merged.length >= limit) break;
  }
  return merged;
}

async function lexicalSearch(userId: string, queryText: string, opts: SearchOptions, limit: number) {
  const params: unknown[] = [userId, queryText];
  const clauses = ['m.user_id=$1', `m.search_vector @@ plainto_tsquery('simple',$2)`];
  applyFilters(opts, params, clauses);
  params.push(limit);
  const r = await query(
    `SELECT ${SEARCH_COLUMNS}, ts_rank_cd(m.search_vector, plainto_tsquery('simple',$2)) AS "textScore"
     FROM memories m ${MEMORY_PROVENANCE_JOIN} WHERE ${clauses.join(' AND ')}
     ORDER BY ${orderFor(opts.sort)} LIMIT $${params.length}`,
    params
  );
  return r.rows;
}

/**
 * Token substring match, ranked by how much of the query each row actually
 * matched rather than by importance alone.
 *
 * Ranking is plain SQL on purpose: migration 005 adds pg_trgm GIN indexes that
 * make these leading-wildcard LIKE patterns index-backed instead of a full scan,
 * but no pg_trgm *function* is called here. A database that has not run 005 yet
 * therefore still returns correct results — just more slowly — rather than
 * failing on an unknown function, which would turn a pending migration into
 * broken search.
 *
 * A title hit scores above a content/summary hit, and scores sum across tokens,
 * so a memory matching every word of the query outranks one matching a single
 * word. The previous fallback ordered only by importance, which meant the least
 * relevant high-importance memory outranked an exact match.
 */
async function substringSearch(userId: string, tokens: string[], opts: SearchOptions, limit: number) {
  const params: unknown[] = [userId];
  const clauses = ['m.user_id=$1'];
  applyFilters(opts, params, clauses);

  const matchConditions: string[] = [];
  const scoreTerms: string[] = [];
  for (const token of tokens) {
    params.push(`%${token}%`);
    const p = `$${params.length}`;
    matchConditions.push(`(lower(m.title) LIKE ${p} OR lower(m.content) LIKE ${p} OR lower(coalesce(m.summary,'')) LIKE ${p})`);
    scoreTerms.push(`(CASE WHEN lower(m.title) LIKE ${p} THEN 2 WHEN lower(m.content) LIKE ${p} OR lower(coalesce(m.summary,'')) LIKE ${p} THEN 1 ELSE 0 END)`);
  }
  clauses.push(`(${matchConditions.join(' OR ')})`);
  const matchScore = scoreTerms.join(' + ');
  // Normalised so "textScore" stays a 0..1 relevance figure, the same shape
  // ts_rank_cd yields on the lexical path.
  const normalized = `(${matchScore})::float / ${tokens.length * 2}`;
  const order = opts.sort === 'newest'
    ? 'm.updated_at DESC'
    : opts.sort === 'importance'
      ? 'm.importance DESC, m.updated_at DESC'
      : `(${matchScore}) DESC, m.importance DESC, m.updated_at DESC`;

  params.push(limit);
  const r = await query(
    `SELECT ${SEARCH_COLUMNS}, ${normalized} AS "textScore" FROM memories m ${MEMORY_PROVENANCE_JOIN}
     WHERE ${clauses.join(' AND ')} ORDER BY ${order} LIMIT $${params.length}`, params);
  return r.rows;
}

export async function buildContextPackage(userId: string, queryText: string, projectId?: string) {
  const memories = await searchMemories(userId, queryText, { projectId, limit: 12 });
  const relations = memories.length ? await query(`SELECT r.from_memory_id AS "fromMemoryId", r.to_memory_id AS "toMemoryId", r.relation_type AS "relationType", r.confidence FROM relations r WHERE r.user_id=$1 AND (r.from_memory_id = ANY($2::uuid[]) OR r.to_memory_id = ANY($2::uuid[])) LIMIT 100`, [userId, memories.map(m => m.id)]) : { rows: [] };
  return {
    version: 'damc-context-v2', query: queryText, projectId: projectId ?? null, generatedAt: new Date().toISOString(),
    memories: memories.map(m => ({ id: m.id, type: m.type, title: m.title, content: m.content, status: m.status, importance: m.importance, confidence: m.confidence, sourceId: m.sourceId, provider: m.provider, textScore: m.textScore })),
    relations: relations.rows
  };
}
