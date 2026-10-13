import { query } from '../db/pool.js';

export async function getGraph(userId: string, projectId?: string) {
  const params: unknown[] = [userId];
  const projectClause = projectId ? (params.push(projectId), ` AND m.project_id=$${params.length}`) : '';
  const nodes = await query(`SELECT m.id, m.title, m.type, m.status, m.project_id AS "projectId" FROM memories m WHERE m.user_id=$1${projectClause} ORDER BY m.updated_at DESC LIMIT 2000`, params);
  const edgeParams: unknown[] = [userId];
  let edgeClause = '';
  if (projectId) { edgeParams.push(projectId); edgeClause = ` AND fm.project_id=$${edgeParams.length} AND tm.project_id=$${edgeParams.length}`; }
  const rels = await query(`SELECT r.from_memory_id AS "from", r.to_memory_id AS "to", r.relation_type AS "type", r.confidence FROM relations r JOIN memories fm ON fm.id=r.from_memory_id JOIN memories tm ON tm.id=r.to_memory_id WHERE r.user_id=$1${edgeClause}`, edgeParams);
  return { nodes: nodes.rows, edges: rels.rows };
}
