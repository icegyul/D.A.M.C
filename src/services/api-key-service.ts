import crypto from 'node:crypto';
import { query } from '../db/pool.js';

export function hashApiKey(key: string) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

export async function createApiKey(userId: string, label = 'default') {
  const raw = `damc_${crypto.randomBytes(24).toString('base64url')}`;
  const prefix = raw.slice(0, 12);
  await query(`INSERT INTO api_keys(user_id,key_prefix,key_hash,label) VALUES($1,$2,$3,$4)`, [userId, prefix, hashApiKey(raw), label]);
  return { key: raw, prefix, label };
}

export async function resolveApiKey(raw: string) {
  const r = await query<{ user_id: string }>(
    `UPDATE api_keys SET last_used_at=now() WHERE key_hash=$1 AND revoked_at IS NULL RETURNING user_id`,
    [hashApiKey(raw)]
  );
  return r.rows[0]?.user_id ?? null;
}

export interface ApiKeyView {
  id: string;
  label: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/**
 * Listing for the dashboard's key manager. Only the stored prefix is shown —
 * never the hash, and there is no way to recover the raw key after creation.
 */
export async function listApiKeys(userId: string): Promise<ApiKeyView[]> {
  const r = await query<{ id: string; label: string; prefix: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null }>(
    `SELECT id, label, key_prefix AS prefix, created_at AS "createdAt", last_used_at AS "lastUsedAt", revoked_at AS "revokedAt"
     FROM api_keys WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100`, [userId]);
  return r.rows;
}

/** Revoking never deletes the row: last_used_at history survives for auditing. */
export async function revokeApiKey(userId: string, keyId: string): Promise<boolean> {
  const r = await query<{ id: string }>(
    `UPDATE api_keys SET revoked_at=now() WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL RETURNING id`,
    [keyId, userId]);
  return r.rows.length > 0;
}
