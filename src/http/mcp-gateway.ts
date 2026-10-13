/**
 * DAMC Remote MCP Gateway — the published `/mcp` endpoint.
 *
 * Transport: MCP Streamable HTTP (the only remote transport in the current MCP
 * spec). A client POSTs one JSON-RPC message and the server answers with a
 * single `application/json` response — an explicitly allowed shape for servers
 * that stream nothing back on their own. GET (server-initiated SSE) and DELETE
 * (session termination) answer 405, which the spec permits for stateless
 * servers. JSON-RPC batching is not accepted: current clients send single
 * messages, and rejecting arrays keeps a batch from bypassing per-message
 * validation.
 *
 * This endpoint differs from the local `/v1/mcp` in exactly two ways, and both
 * are the point of its existence:
 *   1. Authentication is ALWAYS required — a valid `Authorization: Bearer
 *      damc_…` API key, even when DAMC_DEV_MODE is on. Dev mode exists for
 *      local convenience and is never allowed to become the remote default.
 *   2. Requests are rate-limited per API key.
 *
 * Everything downstream is the same MCP surface every local client uses: the
 * same tools, the same engines, the same user scoping. The key's user_id is
 * the only memory scope the gateway can see.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { handleMcpRequest, isJsonRpcNotification } from '../connectors/mcp/server.js';
import { resolveApiKey } from '../services/api-key-service.js';
import { env } from '../config/env.js';

/** Bodies larger than this are rejected before parsing — tool payloads are small; exports are not taken through MCP. */
export const MCP_BODY_LIMIT = 1024 * 1024;

// ---------------------------------------------------------------------------
// Rate limiting — token bucket per API key, in memory.
// Remote only: the local dashboard and scripts are trusted loopback callers.
// ---------------------------------------------------------------------------

const buckets = new Map<string, { tokens: number; updatedAt: number }>();

/** Test escape hatch: buckets are module-level so tests can start clean. */
export function _resetRateLimiterForTests() {
  buckets.clear();
}

/**
 * Consume one token for `keyId`. Refills continuously at
 * env.DAMC_MCP_RATE_LIMIT_PER_MINUTE tokens per minute up to that capacity.
 * `nowMs` is injectable for tests. Unbounded growth is capped by dropping the
 * map once it grows absurdly — a real deployment has a handful of keys, and a
 * flood of fake keys then simply starts over rather than exhausting memory.
 */
export function consumeRateLimitToken(keyId: string, nowMs = Date.now(), perMinute = env.DAMC_MCP_RATE_LIMIT_PER_MINUTE): { allowed: boolean; retryAfterSeconds: number } {
  if (buckets.size > 10_000) buckets.clear();
  const capacity = perMinute;
  const refillPerMs = perMinute / 60_000;
  let bucket = buckets.get(keyId);
  if (!bucket) {
    bucket = { tokens: capacity, updatedAt: nowMs };
    buckets.set(keyId, bucket);
  }
  const elapsed = nowMs - bucket.updatedAt;
  bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerMs);
  bucket.updatedAt = nowMs;
  if (bucket.tokens < 1) {
    const secondsUntilNext = Math.ceil((1 - bucket.tokens) / refillPerMs / 1000);
    return { allowed: false, retryAfterSeconds: Math.max(1, secondsUntilNext) };
  }
  bucket.tokens -= 1;
  return { allowed: true, retryAfterSeconds: 0 };
}

/**
 * Extract and resolve the Bearer credential. Returns the user id the key
 * belongs to, or null when the header is missing, malformed, or unknown —
 * the caller answers 401 without distinguishing which, so a probe learns
 * nothing about which part was wrong.
 */
export async function authenticateGatewayRequest(authorization: string | undefined): Promise<string | null> {
  if (!authorization?.startsWith('Bearer ')) return null;
  const raw = authorization.slice(7).trim();
  if (!raw) return null;
  return resolveApiKey(raw);
}

function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: '2.0', id: typeof id === 'string' || typeof id === 'number' ? id : null, error: { code, message } };
}

export async function registerMcpGateway(app: FastifyInstance) {
  const postHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    const userId = await authenticateGatewayRequest(req.headers.authorization);
    if (!userId) {
      return reply.code(401)
        .header('WWW-Authenticate', 'Bearer realm="damc-mcp"')
        .send(rpcError((req.body as any)?.id, -32001, 'Authentication required: pass a DAMC API key as `Authorization: Bearer damc_…`. Create one in the DAMC dashboard (Sync Center → API keys).'));
    }

    const keyId = req.headers.authorization!.slice(7).trim();
    const limit = consumeRateLimitToken(keyId);
    if (!limit.allowed) {
      return reply.code(429)
        .header('Retry-After', String(limit.retryAfterSeconds))
        .send(rpcError((req.body as any)?.id, -32002, `Rate limit exceeded. Retry after ${limit.retryAfterSeconds}s.`));
    }

    // A notification expects no result: 202 with an empty body, per transport spec.
    if (isJsonRpcNotification(req.body)) return reply.code(202).send();

    const response = await handleMcpRequest(req.body, {
      userId,
      headers: req.headers as Record<string, unknown>,
      logError: (error, method) => req.log.error({ err: error, method }, 'mcp gateway request failed')
    });
    return reply.header('Cache-Control', 'no-store').send(response);
  };

  app.post('/mcp', { bodyLimit: MCP_BODY_LIMIT }, postHandler);

  // Stateless server: no server-initiated streams to subscribe to.
  app.get('/mcp', async (_req, reply) => {
    return reply.code(405)
      .header('Allow', 'POST')
      .send(rpcError(null, -32000, 'This DAMC gateway is stateless: it does not offer server-initiated SSE streams. POST JSON-RPC messages instead.'));
  });

  app.delete('/mcp', async (_req, reply) => {
    return reply.code(405)
      .header('Allow', 'POST')
      .send(rpcError(null, -32000, 'This DAMC gateway keeps no MCP sessions; nothing to terminate.'));
  });
}
