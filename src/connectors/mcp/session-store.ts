/**
 * In-memory DAMC session store for cross-provider handoff.
 *
 * session_start records which project a conversation is working on; session_save
 * and session_context pick it up again, so a client only has to name the project
 * once per conversation. The store is deliberately in-process: a session is a
 * conversational device, not durable memory — everything durable a session
 * produces goes through the same memory engine as any other write, and nothing
 * here is the source of truth for anything.
 *
 * Bounded on purpose: TTL on both age and idleness, and a hard cap so a broken
 * client cannot grow the map forever. Restarting DAMC drops open sessions —
 * the client simply calls session_start again, which is one tool call.
 */

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // one day of idleness
const MAX_SESSIONS = 500;

export interface DamcSession {
  id: string;
  userId: string;
  projectId: string | null;
  projectHint: string | null;
  client: string;
  createdAt: string;
  lastUsedAt: number;
}

const sessions = new Map<string, DamcSession>();

function sweep(now: number, ttlMs: number) {
  for (const [id, session] of sessions) {
    if (now - session.lastUsedAt > ttlMs) sessions.delete(id);
  }
}

function newId(): string {
  // Opaque, unguessable-enough handle for a conversational pointer. It guards
  // nothing by itself — every tool call is still authenticated and user-scoped.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

export function createSession(input: {
  userId: string;
  projectId?: string | null;
  projectHint?: string | null;
  client: string;
}): DamcSession {
  const now = Date.now();
  sweep(now, DEFAULT_TTL_MS);
  if (sessions.size >= MAX_SESSIONS) {
    // Evict the least recently used session rather than refusing the write.
    let oldestId: string | null = null;
    let oldest = Infinity;
    for (const [id, s] of sessions) {
      if (s.lastUsedAt < oldest) { oldest = s.lastUsedAt; oldestId = id; }
    }
    if (oldestId) sessions.delete(oldestId);
  }
  const session: DamcSession = {
    id: newId(),
    userId: input.userId,
    projectId: input.projectId ?? null,
    projectHint: input.projectHint ?? null,
    client: input.client,
    createdAt: new Date().toISOString(),
    lastUsedAt: now
  };
  sessions.set(session.id, session);
  return session;
}

/**
 * Look up a session for this exact user. A session belonging to someone else
 * does not exist for this caller — user isolation holds for session handles
 * just as it does for memories.
 */
export function getSession(sessionId: string, userId: string): DamcSession | null {
  const session = sessions.get(sessionId);
  if (!session || session.userId !== userId) return null;
  session.lastUsedAt = Date.now();
  return session;
}

export function closeSession(sessionId: string, userId: string): boolean {
  const session = sessions.get(sessionId);
  if (!session || session.userId !== userId) return false;
  sessions.delete(sessionId);
  return true;
}

/** Test escape hatch: sessions are module-level so tests can start clean. */
export function _resetForTests() {
  sessions.clear();
}
