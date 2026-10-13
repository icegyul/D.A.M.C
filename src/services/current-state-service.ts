import { query } from '../db/pool.js';

export async function buildCurrentState(userId: string, projectId?: string) {
  const params: unknown[] = [userId];
  const projectClause = projectId ? `AND m.project_id=$2` : `AND m.project_id IS NULL`;
  if (projectId) params.push(projectId);

  const r = await query(`
    SELECT m.id, m.type, m.title, m.content, m.summary, m.status, m.importance, m.confidence,
           m.project_id AS "projectId", m.updated_at AS "updatedAt", m.source_id AS "sourceId",
           m.supersedes_id AS "supersedesId"
    FROM memories m
    WHERE m.user_id=$1 ${projectClause}
      AND m.status IN ('active','confirmed')
    ORDER BY m.updated_at DESC
    LIMIT 200`, params);

  const rows = r.rows as any[];
  const byType = (type: string, limit = 20) => rows.filter(x => x.type === type).slice(0, limit);
  const compact = (x: any) => ({ id: x.id, title: x.title, content: x.content, summary: x.summary, status: x.status, importance: x.importance, confidence: x.confidence, updatedAt: x.updatedAt, sourceId: x.sourceId });
  const state = {
    version: 'damc-current-state-v1',
    generatedAt: new Date().toISOString(),
    userId,
    projectId: projectId ?? null,
    decisions: byType('DECISION').map(compact),
    rules: byType('RULE').map(compact),
    constraints: byType('CONSTRAINT').map(compact),
    goals: byType('GOAL').map(compact),
    openIssues: byType('OPEN_ISSUE').map(compact),
    tasks: byType('TASK').map(compact),
    insights: byType('INSIGHT').map(compact),
    questions: byType('QUESTION').map(compact),
    recentKnowledge: rows.filter(x => ['KNOWLEDGE','RESEARCH','HISTORY','COMMIT','EVENT'].includes(x.type)).slice(0, 30).map(compact)
  };

  if (projectId) {
    await query(`
      INSERT INTO current_states(user_id, project_id, state, generated_at)
      VALUES($1,$2,$3,now())
      ON CONFLICT(user_id, project_id) DO UPDATE SET state=EXCLUDED.state, generated_at=EXCLUDED.generated_at`,
      [userId, projectId, state]);
  } else {
    await query(`
      INSERT INTO current_states(user_id, project_id, state, generated_at)
      VALUES($1,NULL,$2,now())
      ON CONFLICT (user_id) WHERE project_id IS NULL
      DO UPDATE SET state=EXCLUDED.state, generated_at=EXCLUDED.generated_at`,
      [userId, state]);
  }

  return state;
}

export async function getStoredCurrentState(userId: string, projectId?: string) {
  const r = await query<{ state: unknown; generated_at: string }>(
    `SELECT state, generated_at FROM current_states WHERE user_id=$1 AND project_id IS NOT DISTINCT FROM $2 LIMIT 1`,
    [userId, projectId ?? null]
  );
  return r.rows[0] ? { ...((r.rows[0].state as object) ?? {}), generatedAt: r.rows[0].generated_at } : null;
}
