/**
 * Remote MCP Gateway (POST /mcp) — the pieces that do not need a database:
 * notification detection, Bearer parsing, and the per-key rate limit.
 *
 * The HTTP layer itself is exercised through handleMcpRequest, which the
 * gateway wraps; full end-to-end auth against a live API key is covered by the
 * database-backed suites (gateway auth is resolveApiKey + a 401 reply, and the
 * api_keys table is the same one the local surface uses).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { isJsonRpcNotification, handleMcpRequest } from '../src/connectors/mcp/server.js';
import { consumeRateLimitToken, _resetRateLimiterForTests, MCP_BODY_LIMIT } from '../src/http/mcp-gateway.js';
import { scanForSecrets, passesAutoRecordBar } from '../src/connectors/mcp/write-policy.js';
import { createSession, getSession, closeSession } from '../src/connectors/mcp/session-store.js';
import { TOOLS } from '../src/connectors/mcp/tools.js';

describe('gateway transport: notifications', () => {
  it('treats id-less notifications/* methods as 202 notifications', () => {
    expect(isJsonRpcNotification({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBe(true);
  });

  it('never treats requests as notifications', () => {
    expect(isJsonRpcNotification({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })).toBe(false);
    expect(isJsonRpcNotification({ jsonrpc: '2.0', method: 'tools/list' })).toBe(false); // no id AND not notifications/*
    expect(isJsonRpcNotification({ jsonrpc: '2.0', id: null, method: 'ping' })).toBe(false);
    expect(isJsonRpcNotification(null)).toBe(false);
    expect(isJsonRpcNotification([1, 2])).toBe(false);
  });
});

describe('gateway transport: initialize negotiation', () => {
  const call = (params: unknown) => handleMcpRequest(
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: params as Record<string, unknown> },
    { userId: '00000000-0000-0000-0000-000000000001', headers: {} }
  );

  it('echoes a protocol version the server supports', async () => {
    const response: any = await call({ protocolVersion: '2025-03-26' });
    expect(response.result.protocolVersion).toBe('2025-03-26');
  });

  it('falls back to the server version for unknown requests', async () => {
    const response: any = await call({ protocolVersion: '1999-01-01' });
    expect(response.result.protocolVersion).toBe('2025-06-18');
  });
});

describe('gateway auth helper contract', () => {
  it('keeps the tool surface free of filesystem/SQL escape hatches', () => {
    for (const tool of TOOLS) {
      expect(tool.name).not.toMatch(/sql|query|exec|file|fs|shell/i);
    }
  });

  it('documents the body limit as 1 MiB — tool payloads, not exports', () => {
    expect(MCP_BODY_LIMIT).toBe(1024 * 1024);
  });
});

describe('gateway rate limit', () => {
  beforeEach(() => _resetRateLimiterForTests());

  it('allows bursts up to the configured capacity, then rejects with a retry hint', () => {
    let rejected = 0;
    let retryAfter = 0;
    for (let i = 0; i < 10; i++) {
      const result = consumeRateLimitToken('key-a', i * 10, 5); // 5/min, 10ms apart
      if (!result.allowed) { rejected++; retryAfter = result.retryAfterSeconds; }
    }
    expect(rejected).toBe(5);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
  });

  it('refills over time', () => {
    expect(consumeRateLimitToken('key-b', 0, 2).allowed).toBe(true);
    expect(consumeRateLimitToken('key-b', 0, 2).allowed).toBe(true);
    expect(consumeRateLimitToken('key-b', 1_000, 2).allowed).toBe(false);
    // Half a minute later both tokens are back.
    expect(consumeRateLimitToken('key-b', 30_000, 2).allowed).toBe(true);
  });

  it('isolates keys from each other', () => {
    for (let i = 0; i < 6; i++) consumeRateLimitToken('key-c', i * 10, 5);
    expect(consumeRateLimitToken('key-c', 100, 5).allowed).toBe(false);
    expect(consumeRateLimitToken('key-d', 100, 5).allowed).toBe(true);
  });
});

describe('write policy: secrets never enter shared memory', () => {
  it.each([
    ['aws key', 'the access key is AKIAIOSFODNN7EXAMPLE for the deploy role'],
    ['github token', 'token ghp_16CharactersFFFFFFFFFFFFFFFF1234 for CI'],
    ['openai key', 'use sk-proj-abcdefghijklmnopqrstuvwx for the demo'],
    ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'],
    ['password assignment', 'DATABASE_PASSWORD=sup3r-s3cret-value'],
    ['connection string', 'postgres://admin:hunter2secret@db.example.com:5432/damc'],
    ['private key', '-----BEGIN RSA PRIVATE KEY-----'],
    ['authorization header', 'authorization: Bearer ey-long-token-value-123456']
  ])('rejects %s', (_label, text) => {
    const scan = scanForSecrets(text);
    expect(scan.clean).toBe(false);
    // The rejection names the problem, never the matched text.
    expect(JSON.stringify(scan)).not.toContain(text);
  });

  it('passes ordinary project content', () => {
    expect(scanForSecrets('배포 방식은 Docker Compose로 결정했다.').clean).toBe(true);
    expect(scanForSecrets('The next sprint focuses on the auth module.').clean).toBe(true);
  });

  it('enforces the auto-record floor for bulk session saves', () => {
    expect(passesAutoRecordBar('결정: 데이터베이스는 PostgreSQL로 유지하기로 최종 결정했다.')).toBe(true);
    expect(passesAutoRecordBar('확인 부탁')).toBe(false);
  });
});

describe('session store', () => {
  const USER = '00000000-0000-0000-0000-0000000000cc';

  it('round-trips a session for the same user', () => {
    const s = createSession({ userId: USER, projectId: null, projectHint: 'damc', client: 'claude-code' });
    expect(getSession(s.id, USER)?.projectHint).toBe('damc');
  });

  it('hides sessions across users', () => {
    const s = createSession({ userId: USER, client: 'cursor' });
    expect(getSession(s.id, '00000000-0000-0000-0000-0000000000dd')).toBeNull();
  });

  it('closes only for the owning user', () => {
    const s = createSession({ userId: USER, client: 'cursor' });
    expect(closeSession(s.id, '00000000-0000-0000-0000-0000000000dd')).toBe(false);
    expect(closeSession(s.id, USER)).toBe(true);
    expect(getSession(s.id, USER)).toBeNull();
  });
});
