import { query } from '../db/pool.js';

export async function getDashboard(userId: string) {
  const [mem, projects, conversations, relations, jobs] = await Promise.all([
    // decisions/tasks are additive fields: the Sync Center's Common Memory block
    // shows real counts instead of deriving them from a page of results.
    query(`SELECT count(*)::int AS total,
             count(*) FILTER (WHERE status='active')::int AS active,
             count(*) FILTER (WHERE status='candidate')::int AS candidates,
             count(*) FILTER (WHERE status='superseded')::int AS superseded,
             count(*) FILTER (WHERE type='DECISION')::int AS decisions,
             count(*) FILTER (WHERE type='DECISION' AND status='active')::int AS "activeDecisions",
             count(*) FILTER (WHERE type='TASK')::int AS tasks,
             count(*) FILTER (WHERE type='TASK' AND status NOT IN ('archived','deprecated','superseded'))::int AS "openTasks"
           FROM memories WHERE user_id=$1`, [userId]),
    query(`SELECT count(*)::int AS total FROM projects WHERE user_id=$1 AND status='active'`, [userId]),
    query(`SELECT count(*)::int AS total, count(DISTINCT provider)::int AS providers FROM conversations WHERE user_id=$1`, [userId]),
    query(`SELECT count(*)::int AS total FROM relations WHERE user_id=$1`, [userId]),
    query(`SELECT id,connector,status,stats,created_at AS "createdAt",finished_at AS "finishedAt" FROM sync_jobs WHERE user_id=$1 ORDER BY created_at DESC LIMIT 5`, [userId])
  ]);
  return { memory: mem.rows[0], projects: projects.rows[0], conversations: conversations.rows[0], relations: relations.rows[0], recentJobs: jobs.rows };
}

export async function listProjects(userId: string) {
  const r = await query(`SELECT id,name,slug,description,status,created_at AS "createdAt",updated_at AS "updatedAt" FROM projects WHERE user_id=$1 ORDER BY updated_at DESC`, [userId]);
  return r.rows;
}
