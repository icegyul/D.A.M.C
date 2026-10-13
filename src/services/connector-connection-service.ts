import { query } from '../db/pool.js';
import { AppError } from '../errors/app-error.js';

/**
 * "Connect" / "disconnect" for a provider, kept deliberately narrow: it is a
 * local, persisted on/off switch for DAMC's own import pipeline (web upload,
 * CLI, watch folder, MCP) for that provider — never an account session, never
 * an OAuth grant. Reuses the `connectors` table that has existed since v0.1
 * (migrations/001_init.sql); no schema change.
 *
 * Only providers DAMC actually has a real local pipeline for are connectable.
 * Anything else fails closed with NOT_SUPPORTED rather than silently no-op'ing.
 */
const CONNECTABLE_PROVIDERS = new Set(['chatgpt', 'claude']);

export class NotSupportedError extends AppError {
  constructor(provider: string) {
    super('NOT_SUPPORTED', `"${provider}" is not a supported provider — nothing to connect or disconnect.`, 400);
  }
}

export function isConnectable(provider: string): boolean {
  return CONNECTABLE_PROVIDERS.has(provider);
}

export interface ConnectionState {
  provider: string;
  connected: boolean;
  connectedAt: string | null;
}

/** Connection state for every connectable provider, defaulting to disconnected when no row exists yet. */
export async function getConnectionStates(userId: string): Promise<Record<string, ConnectionState>> {
  const r = await query<{ provider: string; status: string; updatedAt: string }>(
    `SELECT provider, status, updated_at AS "updatedAt" FROM connectors WHERE user_id=$1`, [userId]);
  const byProvider = new Map(r.rows.map(row => [row.provider, row]));
  const result: Record<string, ConnectionState> = {};
  for (const provider of CONNECTABLE_PROVIDERS) {
    const row = byProvider.get(provider);
    const connected = row?.status === 'enabled';
    result[provider] = { provider, connected, connectedAt: connected ? row!.updatedAt : null };
  }
  return result;
}

export async function connectProvider(userId: string, provider: string): Promise<ConnectionState> {
  if (!isConnectable(provider)) throw new NotSupportedError(provider);
  const r = await query<{ updatedAt: string }>(
    `INSERT INTO connectors(user_id, provider, status, capability, metadata)
     VALUES ($1,$2,'enabled','{}','{}')
     ON CONFLICT (user_id, provider) DO UPDATE SET status='enabled', updated_at=now()
     RETURNING updated_at AS "updatedAt"`,
    [userId, provider]);
  return { provider, connected: true, connectedAt: r.rows[0]!.updatedAt };
}

/**
 * Disables the provider. This touches only the `connectors` row — memories,
 * conversations, sources, messages and relations already created from this
 * provider are never read or written here, so disconnecting can never lose
 * history. (Nothing in this function references those tables at all.)
 */
export async function disconnectProvider(userId: string, provider: string): Promise<ConnectionState> {
  if (!isConnectable(provider)) throw new NotSupportedError(provider);
  await query(
    `INSERT INTO connectors(user_id, provider, status, capability, metadata)
     VALUES ($1,$2,'disconnected','{}','{}')
     ON CONFLICT (user_id, provider) DO UPDATE SET status='disconnected', updated_at=now()`,
    [userId, provider]);
  return { provider, connected: false, connectedAt: null };
}
