/**
 * Remote Access — how a local DAMC becomes reachable by cloud AI clients.
 *
 * DAMC never opens a raw port to the internet. Three paths, in stability
 * order; TLS and authentication always sit in front of the loopback server:
 *
 *   1. NAMED TUNNEL — `DAMC_TUNNEL_TOKEN` set: DAMC runs
 *      `cloudflared tunnel run` as a child process and advertises
 *      `https://DAMC_TUNNEL_HOSTNAME`. The hostname survives restarts: this
 *      is the production path. The token travels in the child's environment
 *      only — never argv, logs, or API responses.
 *   2. MANAGED QUICK TUNNEL — no token: DAMC starts a quick tunnel
 *      (`cloudflared tunnel --url http://127.0.0.1:PORT`) and reads the
 *      generated `https://<random>.trycloudflare.com` URL from its output.
 *      One toggle, nothing exposed on the LAN — but the URL changes every
 *      run, so AI registrations must be re-pointed (`damc ai repoint`).
 *   3. OWN ENDPOINT — `DAMC_PUBLIC_URL` set (reverse proxy or externally
 *      managed tunnel): DAMC only records and advertises that origin.
 *
 * The enabled choice plus the last verify probe are persisted in the
 * `connectors` table (same reserved-key pattern as watch-state-service) so
 * Remote Access — and its last-reachable evidence — survives restarts, and a
 * managed tunnel is re-established on boot when it was left on.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { env } from '../config/env.js';
import { AppError } from '../errors/app-error.js';
import { query } from '../db/pool.js';

const exec = promisify(execFile);
const REMOTE_ACCESS_KEY = 'remote_access';
const TUNNEL_URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const TUNNEL_URL_TIMEOUT_MS = 30_000;

let tunnelProcess: ChildProcess | null = null;
let tunnelUrl: string | null = null;
let tunnelStartedAt: string | null = null;
let tunnelError: string | null = null;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type RemoteAccessSource = 'own_endpoint' | 'named_tunnel' | 'quick_tunnel' | null;

export interface RemoteAccessState {
  /** Operator turned Remote Access on (persists across restarts). */
  enabled: boolean;
  /** The endpoint AI clients should use right now. */
  endpoint: string | null;
  source: RemoteAccessSource;
  /** Quick-tunnel tooling present on this machine? */
  tunnelAvailable: boolean;
  tunnelRunning: boolean;
  tunnelUrl: string | null;
  tunnelStartedAt: string | null;
  tunnelError: string | null;
  /** Last verify probe (Sync Center "Last reachable"); null when never probed. */
  lastVerifiedAt: string | null;
  lastVerifyOk: boolean | null;
}

/** Named-tunnel mode is configured when a token is present. */
export function isNamedTunnelMode(): boolean {
  return Boolean(env.DAMC_TUNNEL_TOKEN);
}

/** The stable public origin a named tunnel serves (hostname only in, origin out). */
export function namedTunnelEndpoint(): string | null {
  const host = (env.DAMC_TUNNEL_HOSTNAME ?? '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  return host ? `https://${host}` : null;
}

async function isEnabled(userId: string): Promise<boolean> {
  const r = await query<{ status: string }>(
    `SELECT status FROM connectors WHERE user_id=$1 AND provider=$2 LIMIT 1`, [userId, REMOTE_ACCESS_KEY]);
  return r.rows[0]?.status === 'enabled';
}

async function setEnabled(userId: string, enabled: boolean, endpoint: string | null, source: Exclude<RemoteAccessSource, null> | null = null): Promise<void> {
  const meta = { endpoint, ...(source ? { source } : {}) };
  await query(
    `INSERT INTO connectors(user_id, provider, status, capability, metadata)
     VALUES ($1,$2,$3,'{}',$4)
     ON CONFLICT (user_id, provider) DO UPDATE SET status=$3,
       metadata = COALESCE(connectors.metadata, '{}'::jsonb) || $4::jsonb, updated_at=now()`,
    [userId, REMOTE_ACCESS_KEY, enabled ? 'enabled' : 'disconnected', JSON.stringify(meta)]);
}

/** Record a verify probe so the Sync Center can show last-reachable evidence. */
export async function recordVerifyResult(userId: string, endpoint: string, ok: boolean): Promise<void> {
  const meta = { lastEndpoint: endpoint, lastVerifiedAt: new Date().toISOString(), lastVerifyOk: ok };
  await query(
    `INSERT INTO connectors(user_id, provider, status, capability, metadata)
     VALUES ($1,$2,'disconnected','{}',$3)
     ON CONFLICT (user_id, provider) DO UPDATE SET
       metadata = COALESCE(connectors.metadata, '{}'::jsonb) || $3::jsonb, updated_at=now()`,
    [userId, REMOTE_ACCESS_KEY, JSON.stringify(meta)]);
}

interface StoredRemoteAccess {
  endpoint?: string | null;
  source?: RemoteAccessSource;
  lastEndpoint?: string | null;
  lastVerifiedAt?: string | null;
  lastVerifyOk?: boolean | null;
}

async function storedState(userId: string): Promise<StoredRemoteAccess> {
  const r = await query<{ metadata: StoredRemoteAccess }>(
    `SELECT metadata FROM connectors WHERE user_id=$1 AND provider=$2 LIMIT 1`, [userId, REMOTE_ACCESS_KEY]);
  return (r.rows[0]?.metadata ?? {}) as StoredRemoteAccess;
}

export async function findCloudflared(): Promise<string | null> {
  if (env.DAMC_CLOUDFLARED_PATH) return env.DAMC_CLOUDFLARED_PATH;
  try {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    const { stdout } = await exec(finder, ['cloudflared'], { timeout: 5000 });
    const path = stdout.trim().split(/\r?\n/)[0];
    return path || null;
  } catch {
    return null;
  }
}

export async function getRemoteAccessState(userId: string): Promise<RemoteAccessState> {
  const [enabled, tunnelAvailable, stored] = await Promise.all([isEnabled(userId), findCloudflared().then(Boolean), storedState(userId)]);
  const tunnelRunning = tunnelProcess !== null;
  const named = isNamedTunnelMode();
  const namedEndpoint = namedTunnelEndpoint();
  const endpoint = env.DAMC_PUBLIC_URL || (named ? namedEndpoint : null) || tunnelUrl;
  // The configured mode wins over history: a token means named tunnel even
  // between restarts; otherwise fall back to what is (or was) running.
  const source: RemoteAccessSource = env.DAMC_PUBLIC_URL
    ? 'own_endpoint'
    : named ? 'named_tunnel' : tunnelRunning ? 'quick_tunnel' : (stored.source ?? null);
  return {
    enabled,
    endpoint,
    source,
    tunnelAvailable,
    tunnelRunning,
    tunnelUrl,
    tunnelStartedAt,
    tunnelError,
    lastVerifiedAt: stored.lastVerifiedAt ?? null,
    lastVerifyOk: stored.lastVerifyOk ?? null
  };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function stopTunnel(): void {
  if (tunnelProcess) {
    try { tunnelProcess.kill(); } catch { /* already gone */ }
  }
  tunnelProcess = null;
  tunnelUrl = null;
  tunnelStartedAt = null;
}

/**
 * Pull a `https://<name>.trycloudflare.com` URL out of cloudflared's log
 * output. Pure (hence unit-tested): the spawn handler below feeds it decoded
 * text, never raw pipe chunks.
 */
export function extractTunnelUrl(output: string): string | null {
  return output.match(TUNNEL_URL_PATTERN)?.[0] ?? null;
}

/**
 * Start a managed tunnel and wait until it is usable.
 *
 * Named mode (DAMC_TUNNEL_TOKEN set): `cloudflared tunnel run` with the token
 * passed in the child's environment — never argv, logs, or API responses.
 * cloudflared prints no URL for named tunnels, so readiness is the
 * "Registered tunnel connection" log line and the endpoint is the configured
 * DAMC_TUNNEL_HOSTNAME. Quick mode prints a trycloudflare.com URL instead.
 * Output is scanned for URLs only; nothing secret ever appears in it.
 */
async function startTunnel(): Promise<string> {
  if (tunnelProcess) return tunnelUrl!;
  const bin = await findCloudflared();
  if (!bin) {
    throw new AppError('CLOUDFLARED_NOT_FOUND',
      'cloudflared is not installed. Install it (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) or set DAMC_PUBLIC_URL to your own HTTPS endpoint.',
      400);
  }
  const named = isNamedTunnelMode();
  if (named && !namedTunnelEndpoint()) {
    throw new AppError('NAMED_TUNNEL_HOSTNAME_MISSING',
      'DAMC_TUNNEL_TOKEN is set but DAMC_TUNNEL_HOSTNAME is not. Set the stable hostname (e.g. memory.example.com) so DAMC can advertise the endpoint.',
      400);
  }
  tunnelError = null;
  const args = named
    ? ['tunnel', '--no-autoupdate', 'run']
    : ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${env.PORT}`];
  const child = spawn(bin, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    ...(named ? { env: { ...process.env, TUNNEL_TOKEN: env.DAMC_TUNNEL_TOKEN } } : {})
  });
  tunnelProcess = child;
  tunnelStartedAt = new Date().toISOString();

  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      tunnelError = 'cloudflared did not report a tunnel URL in time';
      stopTunnel();
      reject(new AppError('TUNNEL_TIMEOUT', tunnelError, 502));
    }, TUNNEL_URL_TIMEOUT_MS);

    // Pipes yield Buffers by default; decode before scanning. (A previous
    // revision typed the chunk as string and called .match on the Buffer,
    // which threw inside the event handler and crashed the server.)
    const onData = (data: Buffer | string) => {
      if (tunnelProcess !== child) return;
      const text = typeof data === 'string' ? data : data.toString('utf8');
      if (named) {
        // Named tunnels print no URL; the registered-connection line is the
        // readiness signal and the endpoint is the configured hostname.
        if (/registered tunnel connection/i.test(text)) {
          clearTimeout(timer);
          tunnelUrl = namedTunnelEndpoint();
          resolve(tunnelUrl!);
        }
        return;
      }
      const match = extractTunnelUrl(text);
      if (match) {
        clearTimeout(timer);
        tunnelUrl = match;
        resolve(tunnelUrl);
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    // Spawn failure (missing binary, no exec permission) must reject fast
    // instead of hanging until the URL timeout.
    child.on('error', (cause) => {
      if (tunnelProcess === child) {
        tunnelProcess = null;
        tunnelUrl = null;
        tunnelStartedAt = null;
        tunnelError = `could not start cloudflared: ${cause instanceof Error ? cause.message : String(cause)}`;
        clearTimeout(timer);
        reject(new AppError('TUNNEL_SPAWN_FAILED', tunnelError, 502));
      }
    });
    child.on('exit', (code, signal) => {
      if (tunnelProcess === child) {
        tunnelProcess = null;
        tunnelUrl = null;
        tunnelStartedAt = null;
        tunnelError = `cloudflared exited (code ${code ?? 'null'}, signal ${signal ?? 'null'})`;
        clearTimeout(timer);
        reject(new AppError('TUNNEL_EXITED', tunnelError, 502));
      }
    });
  });
}

export async function enableRemoteAccess(userId: string): Promise<RemoteAccessState> {
  if (env.DAMC_PUBLIC_URL) {
    // Own endpoint mode: nothing to spawn, the operator's proxy fronts DAMC.
    await setEnabled(userId, true, env.DAMC_PUBLIC_URL, 'own_endpoint');
  } else if (isNamedTunnelMode()) {
    const url = await startTunnel();
    await setEnabled(userId, true, url, 'named_tunnel');
  } else {
    const url = await startTunnel();
    await setEnabled(userId, true, url, 'quick_tunnel');
  }
  return getRemoteAccessState(userId);
}

export async function disableRemoteAccess(userId: string): Promise<RemoteAccessState> {
  stopTunnel();
  await setEnabled(userId, false, null);
  return getRemoteAccessState(userId);
}

/**
 * Boot hook: when the operator left Remote Access on, bring it back. For
 * own-endpoint mode this is a no-op (the proxy is external); managed tunnels
 * get a fresh process. Never fatal — the API comes up either way.
 */
export async function resumeRemoteAccess(userId: string): Promise<void> {
  if (!(await isEnabled(userId))) return;
  if (env.DAMC_PUBLIC_URL) {
    tunnelError = null;
    return;
  }
  try {
    const url = await startTunnel();
    await setEnabled(userId, true, url, isNamedTunnelMode() ? 'named_tunnel' : 'quick_tunnel');
  } catch (error) {
    tunnelError = error instanceof Error ? error.message : String(error);
  }
}

/** Probe that a published endpoint actually answers as DAMC. */
export async function verifyEndpoint(endpoint: string): Promise<{ ok: boolean; status: number | null; message: string }> {
  const url = endpoint.replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(url)) {
    return { ok: false, status: null, message: 'Endpoint must start with http:// or https://.' };
  }
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(8000) });
    const body = await res.json().catch(() => null) as { ok?: boolean; service?: string } | null;
    if (res.ok && body?.ok && body.service === 'damc-backend') {
      return { ok: true, status: res.status, message: `DAMC answered at ${url} (v${(body as any).version ?? '?'})` };
    }
    return { ok: false, status: res.status, message: `Something answered, but it is not DAMC (HTTP ${res.status}).` };
  } catch (error) {
    return { ok: false, status: null, message: `No answer from ${url}: ${error instanceof Error ? error.message : 'network error'}` };
  }
}

/** Test escape hatch: process handles are module-level. */
export function _resetForTests() {
  stopTunnel();
  tunnelError = null;
}
