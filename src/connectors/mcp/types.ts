/**
 * Shared vocabulary for AI clients talking to DAMC.
 *
 * The point of this layer is that DAMC owns the memory and every AI is just a
 * client of it. Nothing here is specific to Claude, Cursor, Gemini or Grok, and
 * nothing here stores per-client memory: every client reads and writes the same
 * DAMC memory through the same engines.
 */

/** Clients DAMC recognises by name. Anything else is accepted as a slug. */
export const KNOWN_CLIENTS = ['claude-code', 'cursor', 'gemini', 'grok', 'chatgpt', 'manual'] as const;
export type KnownClient = typeof KNOWN_CLIENTS[number];

/**
 * Who is calling. Used for provenance and debugging only.
 * Never carries credentials: no API key, token or password belongs here.
 */
export interface ClientIdentity {
  /** Normalized slug, e.g. "claude-code". "unknown" when the caller did not say. */
  id: string;
  /** Client-reported version, when supplied. */
  version: string | null;
  /** Caller-supplied correlation id, echoed back in responses. */
  requestId: string | null;
}

export interface MemoryQuery {
  query?: string;
  projectId?: string;
  type?: string;
  status?: string;
  limit?: number;
}

export interface MemoryResult {
  id: string;
  title: string;
  content: string;
  type: string;
  status: string;
  importance: number;
  confidence: number;
  projectId: string | null;
  projectName: string | null;
  provider: string | null;
  createdAt: string;
  updatedAt: string;
  provenance: {
    provider: string | null;
    sourceId: string | null;
    sourceTitle: string | null;
    sourceExternalId: string | null;
    conversationId: string | null;
    conversationTitle: string | null;
  };
  /** Present on search results only. */
  relevance?: number;
}

export interface MemoryCreateRequest {
  content: string;
  title?: string;
  /** A hint only. The classification engine decides the stored type. */
  type?: string;
  projectId?: string;
  projectHint?: string;
  source?: string;
}

export interface DecisionQuery {
  query?: string;
  projectId?: string;
  limit?: number;
}

export interface TaskQuery {
  query?: string;
  projectId?: string;
  status?: string;
  limit?: number;
}

/**
 * The contract every AI client is a consumer of. Adding a client means pointing
 * it at this surface, not extending the memory engine.
 */
export interface AIConnector {
  searchMemory(userId: string, query: MemoryQuery, client: ClientIdentity): Promise<MemoryResult[]>;
  getMemory(userId: string, memoryId: string, client: ClientIdentity): Promise<unknown>;
  createMemory(userId: string, input: MemoryCreateRequest, client: ClientIdentity): Promise<unknown>;
  searchDecision(userId: string, query: DecisionQuery, client: ClientIdentity): Promise<MemoryResult[]>;
  searchTask(userId: string, query: TaskQuery, client: ClientIdentity): Promise<MemoryResult[]>;
}

/** Request-size ceilings, so a looping client cannot wedge the server. */
export const LIMITS = {
  queryMaxLength: 500,
  titleMaxLength: 300,
  contentMaxLength: 20000,
  limitMax: 100,
  limitDefault: 20
} as const;

const CLIENT_SLUG = /^[a-z0-9][a-z0-9._-]{0,39}$/;

/** Normalize a caller-supplied client name into a safe provenance slug. */
export function normalizeClientId(raw: unknown): string {
  if (typeof raw !== 'string') return 'unknown';
  const slug = raw.trim().toLowerCase().replace(/\s+/g, '-');
  return CLIENT_SLUG.test(slug) ? slug : 'unknown';
}

/**
 * Identify the caller from transport headers, falling back to the MCP
 * initialize handshake's clientInfo.
 */
export function readClientIdentity(
  headers: Record<string, unknown>,
  clientInfo?: { name?: unknown; version?: unknown }
): ClientIdentity {
  const header = (key: string) => {
    const value = headers[key];
    return typeof value === 'string' ? value : undefined;
  };
  const id = normalizeClientId(header('x-damc-client') ?? clientInfo?.name);
  const rawVersion = header('x-damc-client-version') ?? (typeof clientInfo?.version === 'string' ? clientInfo.version : undefined);
  const rawRequestId = header('x-damc-request-id');
  return {
    id,
    version: rawVersion ? String(rawVersion).slice(0, 60) : null,
    requestId: rawRequestId ? String(rawRequestId).slice(0, 100) : null
  };
}

/** Shape a memory row from any of the read paths into the connector contract. */
export function toMemoryResult(row: Record<string, any>): MemoryResult {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    type: row.type,
    status: row.status,
    importance: Number(row.importance),
    confidence: Number(row.confidence),
    projectId: row.projectId ?? null,
    projectName: row.projectName ?? null,
    provider: row.provider ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    provenance: {
      provider: row.provider ?? null,
      sourceId: row.sourceId ?? null,
      sourceTitle: row.sourceTitle ?? null,
      sourceExternalId: row.sourceExternalId ?? null,
      conversationId: row.conversationId ?? null,
      conversationTitle: row.conversationTitle ?? null
    },
    ...(row.textScore !== undefined ? { relevance: Number(row.textScore) } : {})
  };
}
