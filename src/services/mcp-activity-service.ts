/**
 * MCP activity audit — what each AI client actually did to shared memory.
 *
 * The Sync Center's "connection" claims are grounded here: a provider is
 * ACTIVE because a row in audit_logs says its client called a DAMC tool, not
 * because a flag was flipped. Deliberately content-free: tool name, client
 * slug, outcome, timestamp — never the memory text, query or arguments, so
 * this log is safe to keep forever and cannot leak a secret twice.
 *
 * Writes are fire-and-forget: an audit failure must never fail the tool call
 * that produced it.
 */
import { query } from '../db/pool.js';

export const READ_TOOLS = new Set([
  'memory_search', 'memory_get', 'project_memories',
  'decision_search', 'active_decisions', 'task_search'
]);
export const WRITE_TOOLS = new Set([
  'memory_create', 'memory_update', 'memory_restate',
  'decision_create', 'decision_update', 'decision_supersede',
  'task_create', 'task_update', 'task_status'
]);
export const CONTEXT_TOOLS = new Set(['context_pack', 'damc_context']);
export const SESSION_TOOLS = new Set(['session_start', 'session_context', 'session_save']);

export type ToolKind = 'read' | 'write' | 'context' | 'session' | 'other';

export function toolKind(tool: string): ToolKind {
  if (READ_TOOLS.has(tool)) return 'read';
  if (WRITE_TOOLS.has(tool)) return 'write';
  if (CONTEXT_TOOLS.has(tool)) return 'context';
  if (SESSION_TOOLS.has(tool)) return 'session';
  return 'other';
}

export async function recordToolCall(userId: string, clientId: string, tool: string, ok: boolean, projectId: string | null = null): Promise<void> {
  try {
    await query(
      `INSERT INTO audit_logs(user_id,action,entity_type,entity_id,details) VALUES($1,'mcp.tool_call',$2,NULL,$3)`,
      [userId, tool, projectId ? { client: clientId, ok, projectId } : { client: clientId, ok }]);
  } catch { /* auditing must never break the tool call */ }
}

export async function recordClientSeen(userId: string, clientId: string): Promise<void> {
  try {
    await query(
      `INSERT INTO audit_logs(user_id,action,entity_type,entity_id,details) VALUES($1,'mcp.client_seen',NULL,NULL,$2)`,
      [userId, { client: clientId }]);
  } catch { /* auditing must never break the handshake */ }
}

export interface ClientActivity {
  client: string;
  totalCalls: number;
  failedCalls: number;
  lastReadAt: string | null;
  lastWriteAt: string | null;
  lastContextAt: string | null;
  lastSessionAt: string | null;
  lastActivityAt: string | null;
}

/**
 * Per-client activity, aggregated from the audit trail. Bounded scan (most
 * recent 5000 events) — enough history for "when did this AI last touch
 * memory" without growing unbounded with the database.
 */
export async function getActivityByClient(userId: string): Promise<Record<string, ClientActivity>> {
  const r = await query<{ details: Record<string, unknown>; entity_type: string | null; created_at: string }>(
    `SELECT details, entity_type, created_at FROM audit_logs
     WHERE user_id=$1 AND action IN ('mcp.tool_call','mcp.client_seen')
     ORDER BY created_at DESC LIMIT 5000`, [userId]);
  const byClient: Record<string, ClientActivity> = {};
  const touch = (client: string, at: string) => {
    byClient[client] ??= {
      client, totalCalls: 0, failedCalls: 0,
      lastReadAt: null, lastWriteAt: null, lastContextAt: null, lastSessionAt: null, lastActivityAt: null
    };
    const entry = byClient[client];
    if (!entry.lastActivityAt || at > entry.lastActivityAt) entry.lastActivityAt = at;
    return entry;
  };
  for (const row of r.rows) {
    const client = typeof row.details?.client === 'string' ? row.details.client : 'unknown';
    if (row.entity_type === null) { touch(client, row.created_at); continue; } // client_seen handshake
    const entry = touch(client, row.created_at);
    entry.totalCalls += 1;
    if (row.details?.ok === false) entry.failedCalls += 1;
    const kind = toolKind(row.entity_type);
    const slot = kind === 'read' ? 'lastReadAt' : kind === 'write' ? 'lastWriteAt' : kind === 'context' ? 'lastContextAt' : kind === 'session' ? 'lastSessionAt' : null;
    if (slot && (!entry[slot] || row.created_at > entry[slot]!)) entry[slot] = row.created_at;
  }
  return byClient;
}

/** Client slugs a Sync Center provider maps to (an AI's client id is self-reported). */
export const PROVIDER_CLIENT_SLUGS: Record<string, string[]> = {
  // Hermes self-reports through the X-DAMC-Client header its config sends. The
  // bare 'hermes' slug is what normalizeClientId produces from it; 'hermes-agent'
  // is accepted too because that is the upstream package name and a future build
  // could send it as clientInfo.name instead.
  hermes: ['hermes', 'hermes-agent'],
  chatgpt: ['chatgpt'],
  claude: ['claude-code', 'claude'],
  grok: ['grok'],
  perplexity: ['perplexity'],
  cursor: ['cursor']
};

/** Activity for one provider card, merged across that provider's known client slugs. */
export function activityForProvider(byClient: Record<string, ClientActivity>, provider: string): ClientActivity | null {
  const slugs = PROVIDER_CLIENT_SLUGS[provider] ?? [provider];
  const entries = slugs.map(s => byClient[s]).filter(Boolean) as ClientActivity[];
  if (!entries.length) return null;
  const latest = (slot: 'lastReadAt' | 'lastWriteAt' | 'lastContextAt' | 'lastSessionAt' | 'lastActivityAt') =>
    entries.map(e => e[slot]).filter(Boolean).sort().at(-1) ?? null;
  return {
    client: slugs[0]!,
    totalCalls: entries.reduce((n, e) => n + e.totalCalls, 0),
    failedCalls: entries.reduce((n, e) => n + e.failedCalls, 0),
    lastReadAt: latest('lastReadAt'),
    lastWriteAt: latest('lastWriteAt'),
    lastContextAt: latest('lastContextAt'),
    lastSessionAt: latest('lastSessionAt'),
    lastActivityAt: latest('lastActivityAt')
  };
}

export interface RecentToolCall {
  at: string;
  client: string;
  tool: string;
  kind: ToolKind;
  ok: boolean;
  /** Project uuid when the call named one — never names or content. */
  projectId: string | null;
  /** Project name resolved at read time (user-scoped join), for display. */
  projectName: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Pull a project uuid out of tool arguments for the activity feed — and only
 * a uuid. Names, queries and content are never logged: the name is resolved
 * server-side at read time from the projects table instead.
 */
export function projectIdFromArgs(args: unknown): string | null {
  if (typeof args !== 'object' || args === null) return null;
  for (const key of ['project_id', 'projectId']) {
    const v = (args as Record<string, unknown>)[key];
    if (typeof v === 'string' && UUID_RE.test(v)) return v;
  }
  return null;
}

/**
 * Newest-first feed of real MCP tool calls for the Sync Center's "recent
 * memory activity" card. Same content-free rule as the aggregates: client,
 * tool, outcome, time — never arguments, queries or memory text. Bounded to
 * 100 rows; user-scoped like everything else.
 */
export async function getRecentActivity(userId: string, limit = 20): Promise<RecentToolCall[]> {
  const n = Number.isFinite(limit) ? Math.min(100, Math.max(1, Math.floor(limit))) : 20;
  const r = await query<{ at: string; tool: string | null; projectId: string | null; projectName: string | null; details: Record<string, unknown> }>(
    `SELECT a.created_at AS at, a.entity_type AS tool,
            a.details->>'projectId' AS "projectId", p.name AS "projectName", a.details
     FROM audit_logs a LEFT JOIN projects p
       ON p.id = NULLIF(a.details->>'projectId','')::uuid AND p.user_id = a.user_id
     WHERE a.user_id=$1 AND a.action='mcp.tool_call'
     ORDER BY a.created_at DESC LIMIT $2`, [userId, n]);
  return r.rows.map(row => {
    const tool = typeof row.tool === 'string' ? row.tool : 'unknown';
    return {
      at: row.at,
      client: typeof row.details?.client === 'string' ? row.details.client : 'unknown',
      tool,
      kind: toolKind(tool),
      ok: row.details?.ok !== false,
      projectId: typeof row.projectId === 'string' ? row.projectId : null,
      projectName: typeof row.projectName === 'string' ? row.projectName : null
    };
  });
}
