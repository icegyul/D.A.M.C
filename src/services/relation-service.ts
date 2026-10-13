import { query } from '../db/pool.js';

function tokens(s: string) {
  return new Set(s.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(x => x.length >= 4).slice(0, 80));
}

function similarity(a: string, b: string) {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let common = 0;
  for (const x of A) if (B.has(x)) common++;
  return common / Math.sqrt(A.size * B.size);
}

export async function linkRelatedMemories(userId: string, memoryId: string, projectId?: string) {
  const current = await query<any>(`SELECT id,title,content,project_id AS "projectId" FROM memories WHERE id=$1 AND user_id=$2`, [memoryId, userId]);
  if (!current.rows[0]) return { created: 0 };
  const c = current.rows[0];
  const params: unknown[] = [userId, memoryId];
  let clause = `user_id=$1 AND id<>$2 AND status IN ('active','confirmed')`;
  if (projectId) { params.push(projectId); clause += ` AND project_id=$${params.length}`; }
  const candidates = await query<any>(`SELECT id,title,content FROM memories WHERE ${clause} ORDER BY updated_at DESC LIMIT 80`, params);
  let created = 0;
  for (const other of candidates.rows) {
    const score = similarity(`${c.title}\n${c.content}`, `${other.title}\n${other.content}`);
    if (score < 0.28) continue;
    await query(`INSERT INTO relations(user_id,from_memory_id,to_memory_id,relation_type,confidence,metadata)
      VALUES($1,$2,$3,'RELATED_TO',$4,$5) ON CONFLICT DO NOTHING`,
      [userId, memoryId, other.id, Math.min(0.99, score), { method: 'token-overlap-v1' }]);
    created++;
  }
  return { created };
}
