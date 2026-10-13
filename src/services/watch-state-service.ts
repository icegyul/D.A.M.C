import { query } from '../db/pool.js';

/**
 * Remembers whether the operator left the watch folder switched on, so it comes
 * back by itself after `docker compose restart`, a Windows reboot, or any other
 * restart of the app container. Without this the watcher lived only in process
 * memory: it survived nothing, and "자동 감시 중" silently became false the next
 * time the machine came up.
 *
 * Stored in the `connectors` table (present since v0.1) under a reserved
 * provider key, so this needs no migration and no new table. The key is
 * deliberately not a provider name — nothing about it is connectable through
 * connector-connection-service, which whitelists chatgpt/claude only.
 */
const WATCH_FOLDER_KEY = 'local_watch_folder';

export async function setWatchFolderEnabled(userId: string, enabled: boolean): Promise<void> {
  await query(
    `INSERT INTO connectors(user_id, provider, status, capability, metadata)
     VALUES ($1,$2,$3,'{}','{}')
     ON CONFLICT (user_id, provider) DO UPDATE SET status=$3, updated_at=now()`,
    [userId, WATCH_FOLDER_KEY, enabled ? 'enabled' : 'disconnected']);
}

export async function isWatchFolderEnabled(userId: string): Promise<boolean> {
  const r = await query<{ status: string }>(
    `SELECT status FROM connectors WHERE user_id=$1 AND provider=$2 LIMIT 1`, [userId, WATCH_FOLDER_KEY]);
  return r.rows[0]?.status === 'enabled';
}
