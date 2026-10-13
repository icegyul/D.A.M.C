import { query } from '../db/pool.js';

export async function findOrCreateProject(userId: string, name: string): Promise<string> {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9가-힣]+/gi, '-').replace(/^-|-$/g, '').slice(0, 80) || 'default';
  const existing = await query<{id:string}>(`SELECT id FROM projects WHERE user_id=$1 AND slug=$2 LIMIT 1`, [userId, slug]);
  if (existing.rows[0]) return existing.rows[0].id;
  const created = await query<{id:string}>(`INSERT INTO projects(user_id,name,slug) VALUES($1,$2,$3) RETURNING id`, [userId, name.trim(), slug]);
  return created.rows[0]!.id;
}
