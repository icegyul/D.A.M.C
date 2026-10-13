/**
 * Context Pack — a structured, size-bounded summary of Common Memory, meant to
 * be handed to whichever AI a conversation happens to be in right now.
 *
 * This is deliberately a different function from buildContextPackage
 * (retrieval-service.ts): that one is the query-driven v2 shape kept for the
 * damc_context MCP tool and GET /v1/context, both shipped since 1.0.0 and left
 * untouched here. A Context Pack answers a different question — not "what
 * matches this search text" but "what does DAMC currently know that matters
 * for this project" — organized into the buckets a human or an AI can read
 * without wading through a raw memory dump.
 *
 * Every query here reuses the same provenance join/columns memory-repository.ts
 * already defines. No new table, no new column.
 */
import { query } from '../db/pool.js';
import { MEMORY_PROVENANCE_JOIN, MEMORY_PROVENANCE_COLUMNS } from '../repositories/memory-repository.js';

const LIMITS = {
  activeDecisions: 10,
  activeTasks: 10,
  constraints: 8,
  importantMemories: 8,
  recentContext: 6,
  provenanceVersionsPerMemory: 5
};

export interface ContextPackOptions {
  projectId?: string;
}

const PACK_COLUMNS = `m.id, m.type, m.title, m.content, m.summary, m.status,
  m.importance::float AS importance, m.confidence::float AS confidence,
  m.updated_at AS "updatedAt", m.source_id AS "sourceId",${MEMORY_PROVENANCE_COLUMNS}`;

async function getProject(userId: string, projectId: string) {
  const r = await query<{ id: string; name: string; slug: string; description: string | null }>(
    `SELECT id, name, slug, description FROM projects WHERE user_id=$1 AND id=$2 LIMIT 1`, [userId, projectId]);
  return r.rows[0] ?? null;
}

function projectFilter(projectId: string | undefined, params: unknown[], clauses: string[]) {
  if (projectId) { params.push(projectId); clauses.push(`m.project_id=$${params.length}`); }
}

async function activeDecisions(userId: string, projectId?: string) {
  const params: unknown[] = [userId];
  const clauses = ['m.user_id=$1', `m.type='DECISION'`, `m.status='active'`];
  projectFilter(projectId, params, clauses);
  params.push(LIMITS.activeDecisions);
  const r = await query(`SELECT ${PACK_COLUMNS} FROM memories m ${MEMORY_PROVENANCE_JOIN}
    WHERE ${clauses.join(' AND ')} ORDER BY m.updated_at DESC LIMIT $${params.length}`, params);
  return r.rows;
}

async function activeTasks(userId: string, projectId?: string) {
  const params: unknown[] = [userId];
  // "Active" for a TASK means still open: never auto-promoted, never
  // auto-closed — only archived/deprecated/superseded takes it out of view.
  const clauses = ['m.user_id=$1', `m.type='TASK'`, `m.status NOT IN ('archived','deprecated','superseded')`];
  projectFilter(projectId, params, clauses);
  params.push(LIMITS.activeTasks);
  const r = await query(`SELECT ${PACK_COLUMNS} FROM memories m ${MEMORY_PROVENANCE_JOIN}
    WHERE ${clauses.join(' AND ')} ORDER BY m.updated_at DESC LIMIT $${params.length}`, params);
  return r.rows;
}

async function activeConstraints(userId: string, projectId?: string) {
  const params: unknown[] = [userId];
  const clauses = ['m.user_id=$1', `m.type IN ('CONSTRAINT','RULE')`, `m.status IN ('active','confirmed')`];
  projectFilter(projectId, params, clauses);
  params.push(LIMITS.constraints);
  const r = await query(`SELECT ${PACK_COLUMNS} FROM memories m ${MEMORY_PROVENANCE_JOIN}
    WHERE ${clauses.join(' AND ')} ORDER BY m.updated_at DESC LIMIT $${params.length}`, params);
  return r.rows;
}

/**
 * High-importance memories not already covered by the buckets above.
 * HISTORY is excluded on principle here — a raw conversation-history dump is
 * exactly what a Context Pack exists to avoid; recentContext below still
 * allows a little of it, but only the newest handful, never "all of it".
 */
async function importantMemories(userId: string, projectId?: string) {
  const params: unknown[] = [userId];
  const clauses = ['m.user_id=$1', `m.status IN ('active','confirmed')`, `m.type NOT IN ('DECISION','TASK','CONSTRAINT','RULE','HISTORY')`];
  projectFilter(projectId, params, clauses);
  params.push(LIMITS.importantMemories);
  const r = await query(`SELECT ${PACK_COLUMNS} FROM memories m ${MEMORY_PROVENANCE_JOIN}
    WHERE ${clauses.join(' AND ')} ORDER BY m.importance DESC, m.updated_at DESC LIMIT $${params.length}`, params);
  return r.rows;
}

async function recentContext(userId: string, projectId?: string) {
  const params: unknown[] = [userId];
  const clauses = ['m.user_id=$1', `m.status NOT IN ('archived','deprecated')`];
  projectFilter(projectId, params, clauses);
  params.push(LIMITS.recentContext);
  const r = await query(`SELECT ${PACK_COLUMNS} FROM memories m ${MEMORY_PROVENANCE_JOIN}
    WHERE ${clauses.join(' AND ')} ORDER BY m.updated_at DESC LIMIT $${params.length}`, params);
  return r.rows;
}

/**
 * Per-memory provenance, including every provider that ever restated the same
 * Common Memory (memory-engine's RESTATE path adds a version per restatement
 * without creating a second memory) — this is where a cross-provider merge
 * actually becomes visible: one memory, multiple sources.
 */
async function provenanceFor(memoryIds: string[]) {
  if (!memoryIds.length) return new Map<string, Array<{ provider: string | null; changeReason: string | null; createdAt: string }>>();
  const r = await query<{ memoryId: string; provider: string | null; changeReason: string | null; createdAt: string }>(
    `SELECT mv.memory_id AS "memoryId", s.provider AS "provider", mv.change_reason AS "changeReason", mv.created_at AS "createdAt"
     FROM memory_versions mv LEFT JOIN sources s ON s.id = mv.source_id
     WHERE mv.memory_id = ANY($1::uuid[]) ORDER BY mv.memory_id, mv.version_no DESC`, [memoryIds]);
  const map = new Map<string, Array<{ provider: string | null; changeReason: string | null; createdAt: string }>>();
  for (const row of r.rows) {
    const list = map.get(row.memoryId) ?? [];
    if (list.length < LIMITS.provenanceVersionsPerMemory) list.push({ provider: row.provider, changeReason: row.changeReason, createdAt: row.createdAt });
    map.set(row.memoryId, list);
  }
  return map;
}

function shape(row: any, provenanceByMemory: Map<string, unknown[]>) {
  const versions = provenanceByMemory.get(row.id) ?? [];
  // The primary provenance (the memory's own source_id) is always present;
  // additional providers only show up if this memory was restated elsewhere.
  const providers = [...new Set([row.provider, ...versions.map((v: any) => v.provider)].filter(Boolean))];
  return {
    id: row.id, type: row.type, title: row.title, content: row.content, summary: row.summary,
    status: row.status, importance: row.importance, confidence: row.confidence, updatedAt: row.updatedAt,
    provider: row.provider, providers, crossProvider: providers.length > 1,
    provenance: { primary: { provider: row.provider, conversationId: row.conversationId, sourceTitle: row.sourceTitle }, restatedBy: versions }
  };
}

export async function buildContextPack(userId: string, opts: ContextPackOptions = {}) {
  const { projectId } = opts;
  const [project, decisions, tasks, constraints, important, recent] = await Promise.all([
    projectId ? getProject(userId, projectId) : Promise.resolve(null),
    activeDecisions(userId, projectId),
    activeTasks(userId, projectId),
    activeConstraints(userId, projectId),
    importantMemories(userId, projectId),
    recentContext(userId, projectId)
  ]);

  const allRows = [...decisions, ...tasks, ...constraints, ...important, ...recent];
  const seen = new Set<string>();
  const memoryIds = allRows.filter(r => (seen.has(r.id) ? false : (seen.add(r.id), true))).map(r => r.id);
  const provenanceByMemory = await provenanceFor(memoryIds);

  return {
    version: 'damc-context-pack-v1',
    generatedAt: new Date().toISOString(),
    project: project ? { id: project.id, name: project.name, slug: project.slug, description: project.description } : null,
    activeDecisions: decisions.map(r => shape(r, provenanceByMemory)),
    activeTasks: tasks.map(r => shape(r, provenanceByMemory)),
    constraints: constraints.map(r => shape(r, provenanceByMemory)),
    importantMemories: important.map(r => shape(r, provenanceByMemory)),
    recentContext: recent.map(r => shape(r, provenanceByMemory)),
    counts: {
      activeDecisions: decisions.length, activeTasks: tasks.length, constraints: constraints.length,
      importantMemories: important.length, recentContext: recent.length
    }
  };
}

/** Plain-text rendering meant to be pasted into any AI's chat box — no provider-specific format exists to push into, so this is the one shape every provider can read. */
export function formatContextPackAsText(pack: Awaited<ReturnType<typeof buildContextPack>>): string {
  const lines: string[] = [];
  lines.push(`PROJECT: ${pack.project?.name ?? '(none selected)'}`);
  lines.push('');
  const section = (title: string, rows: Array<{ title: string; content: string; providers: string[] }>) => {
    lines.push(`${title}:`);
    if (!rows.length) { lines.push('- (none)'); lines.push(''); return; }
    for (const r of rows) {
      const provenance = r.providers.length > 1 ? ` [${r.providers.join(' + ')}]` : r.providers.length ? ` [${r.providers[0]}]` : '';
      lines.push(`- ${r.content}${provenance}`);
    }
    lines.push('');
  };
  section('ACTIVE DECISIONS', pack.activeDecisions);
  section('ACTIVE TASKS', pack.activeTasks);
  section('CONSTRAINTS', pack.constraints);
  section('IMPORTANT MEMORY', pack.importantMemories);
  section('RECENT CONTEXT', pack.recentContext);
  return lines.join('\n').trim();
}
