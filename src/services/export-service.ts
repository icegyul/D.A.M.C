import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';
import { query } from '../db/pool.js';

/**
 * A memory title as a note file name, valid on the filesystems the vault can sit
 * on: ext4 inside the container AND NTFS through the Docker Desktop bind mount.
 *
 * Bounded in UTF-8 BYTES, not characters. A title of 150 Korean or box-drawing
 * characters is 450 bytes; the per-name limit is 255, and the `-<id8>.md` suffix
 * needs 12 of them. 120 bytes leaves room and still reads as the title.
 * Windows additionally rejects trailing dots and spaces and the DOS device names,
 * and neither filesystem wants control characters in a name.
 *
 * Exported for tests; the export itself always appends the id suffix.
 */
export function obsidianNoteName(title: string, maxBytes = 120): string {
  let name = (title ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')      // control characters
    .replace(/[\\/:*?"<>|]/g, '-')                // path and NTFS-reserved characters
    .replace(/\s+/g, ' ')
    .trim();
  // Cut on a character boundary so a multi-byte character is never split.
  if (Buffer.byteLength(name, 'utf8') > maxBytes) {
    let cut = '';
    for (const ch of name) {
      if (Buffer.byteLength(cut + ch, 'utf8') > maxBytes) break;
      cut += ch;
    }
    name = cut;
  }
  name = name.replace(/[. ]+$/g, '');               // NTFS drops trailing dots/spaces silently
  if (!name) name = 'memory';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) name = `${name}-note`;
  return name;
}
const safeName = obsidianNoteName;
function yaml(s: string) { return s.replace(/\n/g, ' ').replace(/"/g, '\\"'); }

/** Where the Obsidian export is written. One place, so status and export agree. */
export function obsidianRoot(): string {
  return env.OBSIDIAN_VAULT_PATH || path.join(env.DATA_DIR, 'obsidian');
}

export interface ObsidianStatus {
  /** Path Node writes to (inside the container when containerised). */
  vaultPath: string;
  /** The same folder in the user's terms — what to open in Obsidian. */
  hostPath: string;
  folderExists: boolean;
  /** True once an index note exists, i.e. a sync has completed at least once. */
  synced: boolean;
  lastSyncAt: string | null;
  noteCount: number;
  /** What the next sync would write, from the live database. */
  targets: { memories: number; decisions: number; tasks: number; relations: number };
}

/**
 * State of the Obsidian vault folder, read from the folder itself rather than from
 * a flag: the index note's mtime is the last sync, the .md count is what is there.
 * A missing folder is a state, not an error — a fresh install has never synced.
 */
export async function obsidianStatus(userId: string, root = obsidianRoot()): Promise<ObsidianStatus> {
  let folderExists = false;
  let noteCount = 0;
  let lastSyncAt: string | null = null;
  try {
    const entries = await fs.readdir(root);
    folderExists = true;
    noteCount = entries.filter(n => n.endsWith('.md') && n !== '_DAMC_INDEX.md').length;
    try {
      lastSyncAt = (await fs.stat(path.join(root, '_DAMC_INDEX.md'))).mtime.toISOString();
    } catch { /* folder exists but no index yet: never synced */ }
  } catch { /* no folder yet */ }
  const r = await query<{ memories: string; decisions: string; tasks: string; relations: string }>(
    `SELECT
       (SELECT count(*) FROM memories WHERE user_id=$1) AS memories,
       (SELECT count(*) FROM memories WHERE user_id=$1 AND type='DECISION') AS decisions,
       (SELECT count(*) FROM memories WHERE user_id=$1 AND type='TASK') AS tasks,
       (SELECT count(*) FROM relations rel JOIN memories m ON m.id=rel.from_memory_id WHERE m.user_id=$1) AS relations`,
    [userId]);
  const c = r.rows[0] ?? { memories: '0', decisions: '0', tasks: '0', relations: '0' };
  return {
    vaultPath: root,
    hostPath: env.DAMC_OBSIDIAN_HOST_DIR || root,
    folderExists,
    synced: lastSyncAt !== null,
    lastSyncAt,
    noteCount,
    targets: { memories: Number(c.memories), decisions: Number(c.decisions), tasks: Number(c.tasks), relations: Number(c.relations) }
  };
}

export async function exportObsidian(userId: string, root = obsidianRoot()) {
  const memories = await query<{id:string;title:string;type:string;content:string;projectId:string|null;sourceId:string|null;status:string}>(
    `SELECT id,title,type,content,project_id AS "projectId",source_id AS "sourceId",status FROM memories WHERE user_id=$1 ORDER BY updated_at DESC`, [userId]);
  await fs.mkdir(root, { recursive: true });
  // One note name per memory, WITH the id suffix: this is the file name, and it
  // is what a wikilink must contain for Obsidian to resolve it. The relations
  // block used to link the bare title, which matched no file, so no edge was
  // ever drawn — the graph this export exists to produce.
  const noteName = (m: { id: string; title: string }) => `${safeName(m.title)}-${m.id.slice(0, 8)}`;
  const map = new Map<string, string>();
  for (const m of memories.rows) map.set(m.id, noteName(m));
  let failed = 0;
  for (const m of memories.rows) {
    const links = await query<{title:string;id:string;relationType:string}>(
      `SELECT tm.title, tm.id, r.relation_type AS "relationType" FROM relations r JOIN memories tm ON tm.id=r.to_memory_id WHERE r.from_memory_id=$1`, [m.id]);
    const body = `---\ndamc_id: ${m.id}\ntype: ${m.type}\nstatus: ${m.status}\nproject_id: ${m.projectId ?? ''}\nsource_id: ${m.sourceId ?? ''}\n---\n\n# ${m.title}\n\n${m.content}\n\n## Relations\n${links.rows.length ? links.rows.map(l => `- ${l.relationType}: [[${map.get(l.id) ?? noteName(l)}]]`).join('\n') : '- None'}\n`;
    try {
      await fs.writeFile(path.join(root, `${noteName(m)}.md`), body, 'utf8');
    } catch {
      // One unwritable note must not abort the other thousands; the count is
      // returned so the caller can say "synced N, M failed" instead of nothing.
      failed += 1;
    }
  }
  await fs.writeFile(path.join(root, '_DAMC_INDEX.md'), `# DAMC Knowledge Index\n\nGenerated: ${new Date().toISOString()}\n\n${memories.rows.map(m => `- [[${map.get(m.id)}]] — ${m.type}`).join('\n')}\n`, 'utf8');
  return { root, memories: memories.rows.length - failed, failed };
}

export async function exportJson(userId: string, root = path.join(env.DATA_DIR, 'backup')) {
  await fs.mkdir(root, { recursive: true });
  const [memories, relations, conversations, projects, sources] = await Promise.all([
    query(`SELECT * FROM memories WHERE user_id=$1 ORDER BY updated_at`, [userId]),
    query(`SELECT * FROM relations WHERE user_id=$1 ORDER BY created_at`, [userId]),
    query(`SELECT * FROM conversations WHERE user_id=$1 ORDER BY created_at`, [userId]),
    query(`SELECT * FROM projects WHERE user_id=$1 ORDER BY created_at`, [userId]),
    query(`SELECT * FROM sources WHERE user_id=$1 ORDER BY created_at`, [userId])
  ]);
  const payload = { version: 'damc-backup-v2', exportedAt: new Date().toISOString(), userId, projects: projects.rows, sources: sources.rows, memories: memories.rows, relations: relations.rows, conversations: conversations.rows };
  await fs.writeFile(path.join(root, 'damc-backup.json'), JSON.stringify(payload, null, 2), 'utf8');
  await fs.writeFile(path.join(root, 'MANIFEST.json'), JSON.stringify({ format: 'damc-backup-v2', exportedAt: payload.exportedAt, counts: { projects: projects.rowCount, sources: sources.rowCount, memories: memories.rowCount, relations: relations.rowCount, conversations: conversations.rowCount } }, null, 2), 'utf8');
  return payload;
}
