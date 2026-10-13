/**
 * Common Memory Hub status contract — hermetic (no database).
 *
 * connectionStatusFor() is the function that turns "API key exists + MCP audit
 * activity" into the Sync Center's per-AI state. These tests pin the full
 * ladder (NOT_CONFIGURED → CONFIGURED → AUTHENTICATED → READ_READY /
 * WRITE_READY → ACTIVE) so a future change cannot silently collapse "used"
 * back into "connected", and pin the tool-kind mapping plus the per-provider
 * merge that feed Last read/write/context.
 */
import { describe, it, expect } from 'vitest';
import { connectionStatusFor } from '../src/services/connector-status-service.js';
import { toolKind, activityForProvider, type ClientActivity } from '../src/services/mcp-activity-service.js';
import { extractTunnelUrl } from '../src/services/remote-access-service.js';
import { projectIdFromArgs } from '../src/services/mcp-activity-service.js';

const HOUR = 3600_000;
const recent = () => new Date(Date.now() - 1000).toISOString();
const old = () => new Date(Date.now() - 25 * HOUR).toISOString();

function usage(overrides: Partial<ClientActivity> = {}): ClientActivity {
  return {
    client: 'claude-code', totalCalls: 1, failedCalls: 0,
    lastReadAt: null, lastWriteAt: null, lastContextAt: null, lastSessionAt: null,
    lastActivityAt: null, ...overrides
  };
}

describe('connectionStatusFor', () => {
  it('reports NOT_SUPPORTED when the platform offers no path, whatever the user did', () => {
    expect(connectionStatusFor('not_supported', usage({ lastActivityAt: recent() }), true)).toBe('NOT_SUPPORTED');
    expect(connectionStatusFor('not_supported', null, false)).toBe('NOT_SUPPORTED');
  });

  it('reports NOT_CONFIGURED with no key and no activity', () => {
    expect(connectionStatusFor('available', null, false)).toBe('NOT_CONFIGURED');
    expect(connectionStatusFor('limited', null, false)).toBe('NOT_CONFIGURED');
  });

  it('reports CONFIGURED once a key exists but nothing has been seen', () => {
    expect(connectionStatusFor('available', null, true)).toBe('CONFIGURED');
  });

  it('reports AUTHENTICATED for a handshake with no tool calls — connected, unused, never ACTIVE', () => {
    // Handshake-only: lastActivityAt set (client_seen), every tool slot empty.
    expect(connectionStatusFor('available', usage({ lastActivityAt: old() }), true)).toBe('AUTHENTICATED');
  });

  it('reports READ_READY for past reads without any write', () => {
    const at = old();
    expect(connectionStatusFor('available', usage({ lastActivityAt: at, lastReadAt: at }), true)).toBe('READ_READY');
    expect(connectionStatusFor('available', usage({ lastActivityAt: at, lastContextAt: at }), true)).toBe('READ_READY');
    expect(connectionStatusFor('available', usage({ lastActivityAt: at, lastSessionAt: at }), true)).toBe('READ_READY');
  });

  it('reports WRITE_READY for past writes outside the active window', () => {
    const at = old();
    expect(connectionStatusFor('available', usage({ lastActivityAt: at, lastWriteAt: at, lastReadAt: at }), true)).toBe('WRITE_READY');
  });

  it('reports ACTIVE for any tool call within the last day', () => {
    const at = recent();
    expect(connectionStatusFor('available', usage({ lastActivityAt: at }), true)).toBe('ACTIVE');
    expect(connectionStatusFor('available', usage({ lastActivityAt: at, lastWriteAt: old() }), true)).toBe('ACTIVE');
    expect(connectionStatusFor('limited', usage({ lastActivityAt: at }), false)).toBe('ACTIVE');
  });
});

describe('toolKind', () => {
  it('classifies the gateway tools the activity card depends on', () => {
    expect(toolKind('memory_search')).toBe('read');
    expect(toolKind('active_decisions')).toBe('read');
    expect(toolKind('decision_create')).toBe('write');
    expect(toolKind('task_status')).toBe('write');
    expect(toolKind('context_pack')).toBe('context');
    expect(toolKind('damc_context')).toBe('context');
    expect(toolKind('session_start')).toBe('session');
    expect(toolKind('session_save')).toBe('session');
    expect(toolKind('server_info')).toBe('other');
    expect(toolKind('nope')).toBe('other');
  });
});

describe('activityForProvider', () => {
  it('merges a provider’s client slugs, keeping the latest timestamps and summed totals', () => {
    const byClient: Record<string, ClientActivity> = {
      'claude-code': usage({ client: 'claude-code', totalCalls: 3, lastReadAt: old(), lastActivityAt: old() }),
      claude: usage({ client: 'claude', totalCalls: 2, failedCalls: 1, lastReadAt: recent(), lastWriteAt: recent(), lastActivityAt: recent() })
    };
    const merged = activityForProvider(byClient, 'claude')!;
    expect(merged.totalCalls).toBe(5);
    expect(merged.failedCalls).toBe(1);
    expect(merged.lastReadAt).toBe(byClient.claude!.lastReadAt);
    expect(merged.lastWriteAt).toBe(byClient.claude!.lastWriteAt);
    expect(merged.lastActivityAt).toBe(byClient.claude!.lastActivityAt);
  });

  it('returns null for a provider with no activity at all', () => {
    expect(activityForProvider({}, 'cursor')).toBeNull();
  });
});

describe('extractTunnelUrl', () => {
  it('finds the quick-tunnel URL in cloudflared log noise', () => {
    expect(extractTunnelUrl('2026-09-10 INF + https://bright-otter-42.trycloudflare.com | Your quick Tunnel has been created')).toBe('https://bright-otter-42.trycloudflare.com');
  });

  it('returns null when no tunnel URL was printed', () => {
    expect(extractTunnelUrl('INF Starting tunnel')).toBeNull();
    expect(extractTunnelUrl('')).toBeNull();
  });
});

describe('projectIdFromArgs (activity feed uuid only)', () => {
  const id = '1b163132-030a-496c-ab5f-d2faa13d3cf2';
  it('accepts project_id / projectId uuids', () => {
    expect(projectIdFromArgs({ project_id: id })).toBe(id);
    expect(projectIdFromArgs({ projectId: id })).toBe(id);
  });

  it('rejects names, content, and malformed ids — never logged', () => {
    expect(projectIdFromArgs({ project: 'EARTHUS' })).toBeNull();
    expect(projectIdFromArgs({ query: 'secret text' })).toBeNull();
    expect(projectIdFromArgs({ project_id: 'not-a-uuid' })).toBeNull();
    expect(projectIdFromArgs(null)).toBeNull();
    expect(projectIdFromArgs('string')).toBeNull();
  });
});
