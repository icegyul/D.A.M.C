/**
 * The tools DAMC exposes to AI clients.
 *
 * Every handler delegates to the services the rest of DAMC already uses. Nothing
 * here reimplements retrieval, classification, decision handling or duplicate
 * detection — a write from an AI client goes through exactly the same ingestion
 * pipeline as a file import, so DECISION detection, dimension matching,
 * supersession and content-hash deduplication all apply unchanged.
 */

import { z } from 'zod';
import { sha256 } from '../../lib/hash.js';
import { safeText, truncateSafe } from '../../lib/unicode-safety.js';
import { query, withTransaction, type Queryable } from '../../db/pool.js';
import { searchMemories, buildContextPackage } from '../../services/retrieval-service.js';
import { listMemories, getMemoryDetail, addVersion } from '../../repositories/memory-repository.js';
import { listProjects } from '../../services/dashboard-service.js';
import { findOrCreateProject } from '../../services/project-service.js';
import { ingestConversation } from '../../services/ingestion-service.js';
import { buildContextPack } from '../../services/context-pack-service.js';
import { setMemoryStatus, supersedeMemory, upsertMemoryCandidate } from '../../services/memory-engine.js';
import { createSession, getSession, closeSession } from './session-store.js';
import { scanForSecrets, passesAutoRecordBar } from './write-policy.js';
import { LIMITS, toMemoryResult, type ClientIdentity, type MemoryResult } from './types.js';
import type { MemoryCandidate, MemoryStatus } from '../../types/domain.js';
import { DAMC_VERSION } from '../../version.js';

/** Re-exported so MCP `initialize` and /health can never report different versions. */
export const SERVER_VERSION = DAMC_VERSION;

export class ToolError extends Error {
  constructor(message: string, public readonly kind: 'invalid_params' | 'not_found' | 'internal' = 'invalid_params') {
    super(message);
    this.name = 'ToolError';
  }
}

const uuid = z.string().uuid();
const limitSchema = z.number().int().positive().max(LIMITS.limitMax).optional();
const querySchema = z.string().trim().min(1).max(LIMITS.queryMaxLength);

function parseArgs<T>(schema: z.ZodType<T>, args: unknown): T {
  const parsed = schema.safeParse(args ?? {});
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path?.length ? `${first.path.join('.')}: ` : '';
    throw new ToolError(`${where}${first?.message ?? 'invalid arguments'}`);
  }
  return parsed.data;
}

/**
 * Search when a query is given, otherwise list. Both paths return provenance,
 * so a client can always see which AI or import a memory came from.
 */
async function readMemories(userId: string, opts: {
  query?: string; projectId?: string; type?: string; status?: string; limit?: number;
}): Promise<MemoryResult[]> {
  const limit = opts.limit ?? LIMITS.limitDefault;
  const rows = opts.query
    ? await searchMemories(userId, opts.query, { projectId: opts.projectId, status: opts.status, limit })
    : await listMemories(userId, { projectId: opts.projectId, type: opts.type as any, status: opts.status as any, limit, sort: 'newest' });
  const typed = opts.query && opts.type ? rows.filter((r: any) => r.type === opts.type) : rows;
  return typed.map(toMemoryResult);
}

// ---------------------------------------------------------------------------
// Argument schemas
// ---------------------------------------------------------------------------

const memorySearchArgs = z.object({
  query: querySchema.optional(),
  project_id: uuid.optional(),
  type: z.string().max(40).optional(),
  status: z.string().max(40).optional(),
  limit: limitSchema
});

const memoryGetArgs = z.object({ memory_id: uuid });
const projectMemoriesArgs = z.object({ project_id: uuid, limit: limitSchema });

// `project` is accepted as a synonym of `project_hint` on every create tool: the
// session tools (session_start/session_context/session_save) settled on
// `project` as their argument name, and a client calling e.g. decision_create
// with the same key it just used for session_start silently landed the memory
// with no project — the schema dropped the unrecognized key rather than
// erroring, so nothing surfaced the mistake. Verified end to end (this
// productization pass) before the fix: decision_create({project:"X"}) stored
// with project_id NULL, no error.
const projectHintAliased = () => z.string().trim().max(120).optional();

const memoryCreateArgs = z.object({
  content: z.string().trim().min(1).max(LIMITS.contentMaxLength),
  title: z.string().trim().max(LIMITS.titleMaxLength).optional(),
  type: z.string().max(40).optional(),
  project_id: uuid.optional(),
  project_hint: projectHintAliased(),
  project: projectHintAliased(),
  source: z.string().trim().max(200).optional()
});

const memoryIdArgs = z.object({ memory_id: uuid });
const memoryUpdateArgs = z.object({
  memory_id: uuid,
  content: z.string().trim().min(1).max(LIMITS.contentMaxLength).optional(),
  title: z.string().trim().min(1).max(LIMITS.titleMaxLength).optional(),
  reason: z.string().trim().max(500).optional()
});
const memoryRestateArgs = z.object({
  memory_id: uuid,
  content: z.string().trim().min(1).max(LIMITS.contentMaxLength).optional()
});
const decisionCreateArgs = z.object({
  content: z.string().trim().min(1).max(LIMITS.contentMaxLength),
  title: z.string().trim().max(LIMITS.titleMaxLength).optional(),
  project_id: uuid.optional(),
  project_hint: projectHintAliased(),
  project: projectHintAliased()
});
const decisionUpdateArgs = z.object({
  memory_id: uuid,
  content: z.string().trim().min(1).max(LIMITS.contentMaxLength),
  reason: z.string().trim().max(500).optional()
});
const decisionSupersedeArgs = z.object({
  memory_id: uuid,
  reason: z.string().trim().max(500).optional()
});
const taskCreateArgs = z.object({
  content: z.string().trim().min(1).max(LIMITS.contentMaxLength),
  title: z.string().trim().max(LIMITS.titleMaxLength).optional(),
  project_id: uuid.optional(),
  project_hint: projectHintAliased(),
  project: projectHintAliased()
});
const taskStatusArgs = z.object({
  memory_id: uuid,
  status: z.enum(['candidate', 'active', 'archived', 'deprecated']),
  reason: z.string().trim().max(500).optional()
});
const taskUpdateArgs = taskStatusArgs.extend({ content: z.string().trim().min(1).max(LIMITS.contentMaxLength).optional() }).partial({ status: true });
const sessionStartArgs = z.object({ project_id: uuid.optional(), project: z.string().trim().max(120).optional() });
const sessionContextArgs = z.object({
  session_id: z.string().trim().min(8).max(64).optional(),
  project_id: uuid.optional(),
  project: z.string().trim().max(120).optional(),
  query: querySchema.optional()
});
const sessionSaveArgs = z.object({
  session_id: z.string().trim().min(8).max(64).optional(),
  project_id: uuid.optional(),
  project: z.string().trim().max(120).optional(),
  items: z.array(z.union([
    z.string().trim().min(1).max(LIMITS.contentMaxLength),
    z.object({ content: z.string().trim().min(1).max(LIMITS.contentMaxLength), title: z.string().trim().max(LIMITS.titleMaxLength).optional() })
  ])).min(1).max(50)
});

// ---------------------------------------------------------------------------
// Shared write helpers
// ---------------------------------------------------------------------------

/** A stored credential can never be un-shared, so every write is scanned first. */
function rejectIfSecret(text: string): void {
  const scan = scanForSecrets(text);
  if (!scan.clean) {
    throw new ToolError(
      `Rejected: the content looks like ${scan.detail}. DAMC never stores credentials, tokens or secrets.`,
      'invalid_params'
    );
  }
}

/**
 * Unicode gate shared by every write tool (and only the write tools): lone
 * surrogates are rejected with a client-readable error, valid text comes back
 * NFC-normalized so hashing and cross-client dedup are encoding-stable.
 * Throws ToolError — never echoes the content, which may hold secrets.
 */
function utext(text: string | undefined, field: string): string | undefined {
  if (text === undefined) return undefined;
  try {
    return safeText(text, field);
  } catch (error) {
    throw new ToolError(error instanceof Error ? error.message : `Invalid ${field}`);
  }
}

/** Resolve an explicit project_id or a hint to a concrete project row (created if new) — same semantics as memory_create. */
async function resolveProject(userId: string, projectId?: string, projectHint?: string): Promise<{ id: string; name: string } | undefined> {
  if (projectId) {
    const project = (await listProjects(userId)).find((p: any) => p.id === projectId);
    if (!project) throw new ToolError(`No project with id ${projectId}`, 'not_found');
    return { id: (project as any).id, name: (project as any).name };
  }
  if (projectHint?.trim()) {
    const id = await findOrCreateProject(userId, projectHint.trim());
    return { id, name: projectHint.trim() };
  }
  return undefined;
}

/**
 * Project resolution for session tools. Name-based resolution matches by exact
 * name or slug and creates the project when new — the same semantics ingestion
 * applies to project hints, so a session never lands in a different project
 * than the memories it saves would.
 */
async function resolveSessionProject(userId: string, projectId?: string, projectName?: string): Promise<{ id: string; name: string } | undefined> {
  if (projectId) {
    const project = (await listProjects(userId)).find((p: any) => p.id === projectId);
    if (!project) throw new ToolError(`No project with id ${projectId}`, 'not_found');
    return { id: (project as any).id, name: (project as any).name };
  }
  if (projectName?.trim()) {
    const needle = projectName.trim().toLowerCase();
    const existing = (await listProjects(userId)).find((p: any) => p.name.toLowerCase() === needle || p.slug === needle);
    if (existing) return { id: (existing as any).id, name: (existing as any).name };
    const id = await findOrCreateProject(userId, projectName.trim());
    return { id, name: projectName.trim() };
  }
  return undefined;
}

/**
 * Provenance row for direct engine writes (decision/task/update/restate) that
 * skip the conversation pipeline. One row per call, so memory_versions and
 * Context Pack provenance can name the client that made the change.
 */
async function createMcpSource(userId: string, client: ClientIdentity, kind: string): Promise<string> {
  const externalId = `mcp-${kind}-${sha256(`${client.id}\n${client.version ?? ''}\n${client.requestId ?? ''}\n${Date.now()}-${Math.random()}`).slice(0, 32)}`;
  const r = await query<{ id: string }>(
    `INSERT INTO sources(user_id,provider,source_type,external_id,title,metadata) VALUES($1,$2,'mcp_tool',$3,$4,$5) RETURNING id`,
    [userId, client.id, externalId, `MCP ${kind} by ${client.id}`, { via: 'mcp', client: client.id, requestId: client.requestId }]);
  return r.rows[0]!.id;
}

/**
 * Store text through the full pipeline — conversation, messages, classification,
 * dedup, supersession — exactly like a file import. This is the ONLY storage
 * path for free-form AI writes: the classifier, not the client, decides what
 * the memory is.
 */
async function storeViaConversation(
  userId: string,
  client: ClientIdentity,
  rawContent: string,
  opts: { title?: string; projectHint?: string; via: string } = { via: 'mcp' }
) {
  // Belt and suspenders: every caller above already validated, but this is the
  // single choke point where free-form AI text becomes a conversation row.
  // safeText throws a plain Error; normalize it to ToolError like utext does.
  let content: string;
  try {
    content = safeText(rawContent, 'content');
  } catch (error) {
    throw new ToolError(error instanceof Error ? error.message : 'Invalid content');
  }
  rejectIfSecret(content);
  const externalId = `mcp-${sha256(`${client.id}\n${opts.title ?? ''}\n${content}`).slice(0, 32)}`;
  return ingestConversation(userId, {
    provider: client.id,
    externalId,
    title: opts.title ?? `${client.id} memory`,
    projectHint: opts.projectHint,
    metadata: {
      via: opts.via,
      client: client.id,
      clientVersion: client.version,
      requestId: client.requestId
    },
    messages: [{ role: 'user', content, sequenceNo: 0 }]
  });
}

interface MemoryRow {
  id: string; type: string; title: string; content: string; summary: string | null;
  status: string; version: number; project_id: string | null; source_id: string | null;
}

const MEMORY_ROW_COLUMNS = `id, type, title, content, summary, status, version, project_id, source_id`;

async function getMemoryRow(userId: string, memoryId: string) {
  const r = await query<MemoryRow>(
    `SELECT ${MEMORY_ROW_COLUMNS} FROM memories WHERE id=$1 AND user_id=$2 LIMIT 1`,
    [memoryId, userId]);
  return r.rows[0] ?? null;
}

/**
 * Run `fn` with the memory row locked, inside one transaction.
 *
 * The handlers below bump `memories.version` and then insert the matching
 * `memory_versions` row. As two separate autocommits those can half-apply,
 * leaving a memory at version N+1 with no history row for N — precisely the gap
 * provenance reads depend on not existing — and two concurrent callers can read
 * the same version and collide on (memory_id, version_no).
 *
 * The row is re-read here rather than reusing the caller's earlier unlocked read
 * so the version written is the one actually current under the lock.
 */
async function withLockedMemory<T>(userId: string, memoryId: string, fn: (tx: Queryable, row: MemoryRow) => Promise<T>): Promise<T> {
  return withTransaction<T>(async tx => {
    const r = await tx.query<MemoryRow>(
      `SELECT ${MEMORY_ROW_COLUMNS} FROM memories WHERE id=$1 AND user_id=$2 FOR UPDATE`, [memoryId, userId]);
    const row = r.rows[0];
    if (!row) throw new ToolError(`No memory with id ${memoryId}`, 'not_found');
    return fn(tx, row);
  });
}

const DECISION_TYPES = ['DECISION', 'RULE', 'CONSTRAINT'];

const decisionSearchArgs = z.object({ query: querySchema.optional(), project_id: uuid.optional(), limit: limitSchema });
const activeDecisionsArgs = z.object({ project_id: uuid.optional(), limit: limitSchema });
const taskSearchArgs = z.object({ query: querySchema.optional(), project_id: uuid.optional(), status: z.string().max(40).optional(), limit: limitSchema });

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (userId: string, args: unknown, client: ClientIdentity) => Promise<unknown>;
}

const object = (properties: Record<string, unknown>, required: string[] = []) =>
  ({ type: 'object', properties, required, additionalProperties: false });

const str = (description: string) => ({ type: 'string', description });
const int = (description: string) => ({ type: 'integer', description, minimum: 1, maximum: LIMITS.limitMax });

export const TOOLS: ToolDefinition[] = [
  {
    name: 'memory_search',
    description: 'Search shared DAMC memory. Returns memories from every AI client and import, with provenance. Omit query to list the most recent.',
    inputSchema: object({
      query: str('Free-text query. Omit to list recent memories.'),
      project_id: str('Restrict to one project (uuid).'),
      type: str('Restrict to a memory type, e.g. DECISION, TASK, KNOWLEDGE.'),
      status: str('Restrict to a lifecycle status, e.g. active, candidate.'),
      limit: int('Maximum results.')
    }),
    handler: async (userId, args) => {
      const a = parseArgs(memorySearchArgs, args);
      const memories = await readMemories(userId, { query: a.query, projectId: a.project_id, type: a.type, status: a.status, limit: a.limit });
      return { count: memories.length, memories };
    }
  },
  {
    name: 'memory_get',
    description: 'Fetch one memory in full, including provenance, version history and both relation directions.',
    inputSchema: object({ memory_id: str('Memory uuid.') }, ['memory_id']),
    handler: async (userId, args) => {
      const a = parseArgs(memoryGetArgs, args);
      const detail = await getMemoryDetail(userId, a.memory_id);
      if (!detail) throw new ToolError(`No memory with id ${a.memory_id}`, 'not_found');
      return { memory: { ...toMemoryResult(detail as any), versions: (detail as any).versions, relations: (detail as any).relations, sourceMessage: (detail as any).sourceMessage } };
    }
  },
  {
    name: 'project_memories',
    description: 'List the memories belonging to one project, newest first.',
    inputSchema: object({ project_id: str('Project uuid.'), limit: int('Maximum results.') }, ['project_id']),
    handler: async (userId, args) => {
      const a = parseArgs(projectMemoriesArgs, args);
      const memories = await readMemories(userId, { projectId: a.project_id, limit: a.limit });
      return { projectId: a.project_id, count: memories.length, memories };
    }
  },
  {
    name: 'memory_create',
    description:
      'Store something in shared DAMC memory. The text goes through the same classification and decision pipeline as an import, so decisions are detected, conflicting decisions supersede earlier ones, and identical content is not stored twice. The type field is a hint only: DAMC decides.',
    inputSchema: object({
      content: str('The text to remember.'),
      title: str('Optional label, recorded as the source title.'),
      type: str('Optional type hint. Recorded, but DAMC classifies the memory itself.'),
      project_id: str('Optional project uuid to attach to.'),
      project_hint: str('Optional project name, used when no project_id is given. `project` is accepted as the same field.'),
      project: str('Alias for project_hint — the name session_start/session_context/session_save use.'),
      source: str('Optional free-text origin, e.g. a file or conversation name.')
    }, ['content']),
    handler: async (userId, args, client) => {
      const a = parseArgs(memoryCreateArgs, args);
      // Unicode first (validation + NFC), then the secret scan — INPUT →
      // validation → normalization → persistence, in that order.
      const content = utext(a.content, 'content')!;
      const title = utext(a.title, 'title');
      // `source` and `type` are free text too, and both land in stored rows.
      const source = utext(a.source, 'source');
      const requestedType = utext(a.type, 'type');
      // The gate every write passes, including this original one — an explicit
      // ask from a client is exactly how a secret would otherwise slip in.
      rejectIfSecret(content);

      // Ingestion resolves projects by name, so an explicit project_id is turned
      // back into its name rather than being silently ignored.
      let projectHint = utext(a.project_hint ?? a.project, 'project_hint');
      if (a.project_id) {
        const project = (await listProjects(userId)).find((p: any) => p.id === a.project_id);
        if (!project) throw new ToolError(`No project with id ${a.project_id}`, 'not_found');
        projectHint = (project as any).name;
      }

      // A stable external id per (client, content) so replaying the same write is
      // idempotent at the conversation level as well as the memory level.
      const externalId = `mcp-${sha256(`${client.id}\n${title ?? ''}\n${content}`).slice(0, 32)}`;

      const result = await ingestConversation(userId, {
        provider: client.id,
        externalId,
        title: title ?? source ?? `${client.id} memory`,
        projectHint,
        metadata: {
          via: 'mcp',
          client: client.id,
          clientVersion: client.version,
          requestId: client.requestId,
          requestedType: requestedType ?? null,
          source: source ?? null
        },
        messages: [{ role: 'user', content, sequenceNo: 0 }]
      });

      return {
        stored: result.memoriesCreated > 0,
        memoriesCreated: result.memoriesCreated,
        memoriesSuperseded: result.memoriesSuperseded,
        duplicate: result.deduplicated || result.memoriesCreated === 0,
        conversationId: result.conversationId,
        provider: client.id,
        note: result.memoriesCreated === 0
          ? 'No memory was created: the text either duplicates an existing memory or carried no content DAMC extracts as a memory.'
          : undefined
      };
    }
  },
  {
    name: 'decision_search',
    description: 'Search decisions specifically. Returns DECISION memories in every lifecycle state, newest first.',
    inputSchema: object({ query: str('Free-text query. Omit to list recent decisions.'), project_id: str('Project uuid.'), limit: int('Maximum results.') }),
    handler: async (userId, args) => {
      const a = parseArgs(decisionSearchArgs, args);
      const decisions = await readMemories(userId, { query: a.query, projectId: a.project_id, type: 'DECISION', limit: a.limit });
      return { count: decisions.length, decisions };
    }
  },
  {
    name: 'active_decisions',
    description: 'List the decisions that currently stand. Superseded decisions are excluded, so this is what is true now.',
    inputSchema: object({ project_id: str('Project uuid.'), limit: int('Maximum results.') }),
    handler: async (userId, args) => {
      const a = parseArgs(activeDecisionsArgs, args);
      const decisions = await readMemories(userId, { projectId: a.project_id, type: 'DECISION', status: 'active', limit: a.limit });
      return { count: decisions.length, decisions };
    }
  },
  {
    name: 'task_search',
    description: 'Search tasks. Tasks are stored as candidates and are never completed automatically by a client.',
    inputSchema: object({ query: str('Free-text query. Omit to list recent tasks.'), project_id: str('Project uuid.'), status: str('Lifecycle status, e.g. candidate, active.'), limit: int('Maximum results.') }),
    handler: async (userId, args) => {
      const a = parseArgs(taskSearchArgs, args);
      const tasks = await readMemories(userId, { query: a.query, projectId: a.project_id, type: 'TASK', status: a.status, limit: a.limit });
      return { count: tasks.length, tasks };
    }
  },
  {
    name: 'memory_update',
    description: 'Correct an existing memory: new content and/or title. The old content is kept as a version, so provenance and history survive. Use for fixing wording or adding detail — to replace a decision use decision_update, which supersedes instead of editing.',
    inputSchema: object({
      memory_id: str('Memory uuid.'),
      content: str('The corrected text. Omit to keep the current content.'),
      title: str('The corrected title. Omit to keep the current title.'),
      reason: str('Why the memory is being corrected.')
    }, ['memory_id']),
    handler: async (userId, args, client) => {
      const a = parseArgs(memoryUpdateArgs, args);
      const row = await getMemoryRow(userId, a.memory_id);
      if (!row) throw new ToolError(`No memory with id ${a.memory_id}`, 'not_found');
      if (!a.content && !a.title) throw new ToolError('Provide content, title, or both');
      const content = utext(a.content, 'content') ?? row.content;
      rejectIfSecret(content);
      const title = utext(a.title, 'title') ?? row.title;
      const reason = utext(a.reason, 'reason');
      const contentHash = sha256(`${row.type}\n${title}\n${content}`);
      return withLockedMemory(userId, a.memory_id, async (tx, locked) => {
        const bumped = await tx.query<{ version: number }>(
          `UPDATE memories SET content=$3, title=$4, summary=$5, content_hash=$6, version=version+1, updated_at=now() WHERE id=$1 AND user_id=$2 RETURNING version`,
          [a.memory_id, userId, content, title, truncateSafe(content, 220), contentHash]);
        await addVersion(a.memory_id, bumped.rows[0]!.version, locked.content, locked.status, reason ?? `Updated via MCP by ${client.id}`, locked.source_id ?? undefined, tx);
        return { updated: true, memoryId: a.memory_id, version: bumped.rows[0]!.version, previousVersion: locked.version };
      });
    }
  },
  {
    name: 'memory_restate',
    description: 'Record that the caller restates an existing memory — the same fact, said again, in this conversation. Adds a version naming this client as another source: one shared memory, more evidence. Never creates a second memory.',
    inputSchema: object({
      memory_id: str('Memory uuid to restate.'),
      content: str('The restated wording. Omit to record the restatement without new wording.')
    }, ['memory_id']),
    handler: async (userId, args, client) => {
      const a = parseArgs(memoryRestateArgs, args);
      const row = await getMemoryRow(userId, a.memory_id);
      if (!row) throw new ToolError(`No memory with id ${a.memory_id}`, 'not_found');
      const restated = utext(a.content, 'content');
      if (restated !== undefined) rejectIfSecret(restated);
      const sourceId = await createMcpSource(userId, client, 'restate');
      return withLockedMemory(userId, a.memory_id, async (tx, locked) => {
        const bumped = await tx.query<{ version: number }>(
          `UPDATE memories SET updated_at=now(), version=version+1 WHERE id=$1 AND user_id=$2 RETURNING version`,
          [a.memory_id, userId]);
        await addVersion(a.memory_id, bumped.rows[0]!.version, restated ?? locked.content, locked.status, `Restated via MCP by ${client.id}`, sourceId, tx);
        return { restated: true, memoryId: a.memory_id, version: bumped.rows[0]!.version, client: client.id };
      });
    }
  },
  {
    name: 'decision_create',
    description: 'Store a settled decision. Unlike memory_create this records the text as a DECISION directly — use it when the caller knows a decision was made. Supersession still applies: a new decision on the same subject automatically replaces the older one.',
    inputSchema: object({
      content: str('The decision, e.g. "배포 방식은 Docker로 결정했다".'),
      title: str('Optional label.'),
      project_id: str('Optional project uuid.'),
      project_hint: str('Optional project name.'),
      project: str('Alias for project_hint — the name session_start/session_context/session_save use.')
    }, ['content']),
    handler: async (userId, args, client) => {
      const a = parseArgs(decisionCreateArgs, args);
      const content = utext(a.content, 'content')!;
      const title = utext(a.title, 'title');
      rejectIfSecret(content);
      const project = await resolveProject(userId, a.project_id, utext(a.project_hint ?? a.project, 'project_hint'));
      const sourceId = await createMcpSource(userId, client, 'decision');
      const candidate: MemoryCandidate = {
        projectHint: project?.name,
        type: 'DECISION',
        title: title ?? `DECISION: ${truncateSafe(content, 90).replace(/\n/g, ' ')}`,
        content,
        summary: truncateSafe(content, 220),
        importance: 0.9,
        confidence: 0.85,
        metadata: { via: 'mcp', client: client.id, requestedType: 'DECISION' }
      };
      const result = await upsertMemoryCandidate({ userId, projectId: project?.id, candidate, sourceId });
      return {
        stored: result.action === 'CREATE' || result.action === 'SUPERSEDE',
        action: result.action,
        memoryId: result.memoryId,
        supersededMemoryId: result.previousMemoryId,
        note: result.action === 'SKIP_DUPLICATE' ? 'An identical decision already exists.' : result.action === 'RESTATE' ? 'Same decision restated — merged into the existing memory with this client as another source.' : undefined
      };
    }
  },
  {
    name: 'decision_update',
    description: 'Replace a specific decision with a new one. The named decision is superseded — kept in history but no longer active — and the new text becomes the standing decision. Use when the caller knows exactly which decision changed.',
    inputSchema: object({
      memory_id: str('The decision uuid being replaced.'),
      content: str('The new decision text.'),
      reason: str('Why the decision changed.')
    }, ['memory_id', 'content']),
    handler: async (userId, args, client) => {
      const a = parseArgs(decisionUpdateArgs, args);
      const content = utext(a.content, 'content')!;
      const reason = utext(a.reason, 'reason');
      rejectIfSecret(content);
      const row = await getMemoryRow(userId, a.memory_id);
      if (!row) throw new ToolError(`No memory with id ${a.memory_id}`, 'not_found');
      if (!DECISION_TYPES.includes(row.type)) throw new ToolError(`Memory ${a.memory_id} is a ${row.type}, not a decision — only DECISION/RULE/CONSTRAINT can be superseded here`);
      if (row.status !== 'active' && row.status !== 'confirmed') throw new ToolError(`Decision ${a.memory_id} is already ${row.status} and cannot be superseded again`);
      const sourceId = await createMcpSource(userId, client, 'decision_update');
      const result = await supersedeMemory({
        userId,
        previousMemoryId: a.memory_id,
        type: row.type as MemoryCandidate['type'],
        title: `${row.type}: ${truncateSafe(content, 90).replace(/\n/g, ' ')}`,
        content,
        summary: truncateSafe(content, 220),
        importance: 0.9,
        confidence: 0.85,
        sourceId,
        projectId: row.project_id ?? undefined,
        reason
      });
      return { superseded: true, memoryId: result.memoryId, previousMemoryId: result.previousMemoryId };
    }
  },
  {
    name: 'decision_supersede',
    description: 'Retire a decision without a replacement: it is no longer standing, and nothing replaces it. Kept in history as superseded.',
    inputSchema: object({
      memory_id: str('The decision uuid to retire.'),
      reason: str('Why the decision no longer stands.')
    }, ['memory_id']),
    handler: async (userId, args) => {
      const a = parseArgs(decisionSupersedeArgs, args);
      const row = await getMemoryRow(userId, a.memory_id);
      if (!row) throw new ToolError(`No memory with id ${a.memory_id}`, 'not_found');
      if (!DECISION_TYPES.includes(row.type)) throw new ToolError(`Memory ${a.memory_id} is a ${row.type}, not a decision`);
      const result = await setMemoryStatus(userId, a.memory_id, 'superseded', utext(a.reason, 'reason') ?? 'Superseded via MCP');
      return { superseded: true, memoryId: result.id, version: result.version };
    }
  },
  {
    name: 'task_create',
    description: 'Store a task. Stored as a candidate — never auto-completed — and searchable via task_search and visible in every Context Pack for its project.',
    inputSchema: object({
      content: str('The task, e.g. "다음 스프린트까지 인증 모듈 구현".'),
      title: str('Optional label.'),
      project_id: str('Optional project uuid.'),
      project_hint: str('Optional project name.'),
      project: str('Alias for project_hint — the name session_start/session_context/session_save use.')
    }, ['content']),
    handler: async (userId, args, client) => {
      const a = parseArgs(taskCreateArgs, args);
      const content = utext(a.content, 'content')!;
      const title = utext(a.title, 'title');
      rejectIfSecret(content);
      const project = await resolveProject(userId, a.project_id, utext(a.project_hint ?? a.project, 'project_hint'));
      const sourceId = await createMcpSource(userId, client, 'task');
      const candidate: MemoryCandidate = {
        projectHint: project?.name,
        type: 'TASK',
        title: title ?? `TASK: ${truncateSafe(content, 90).replace(/\n/g, ' ')}`,
        content,
        summary: truncateSafe(content, 220),
        importance: 0.75,
        confidence: 0.85,
        metadata: { via: 'mcp', client: client.id, requestedType: 'TASK' }
      };
      const result = await upsertMemoryCandidate({ userId, projectId: project?.id, candidate, sourceId });
      return {
        stored: result.action === 'CREATE' || result.action === 'SUPERSEDE',
        action: result.action,
        memoryId: result.memoryId,
        note: result.action === 'SKIP_DUPLICATE' ? 'An identical task already exists.' : result.action === 'RESTATE' ? 'Same task already recorded — merged with this client as another source.' : undefined
      };
    }
  },
  {
    name: 'task_update',
    description: 'Update a task: new wording and/or a new status. The previous wording is kept as a version. Status changes are explicit only — DAMC never completes a task on its own.',
    inputSchema: object({
      memory_id: str('Task memory uuid.'),
      content: str('The updated task text. Omit to keep current wording.'),
      status: str('New status: candidate, active, archived or deprecated.'),
      reason: str('Why the task changed.')
    }, ['memory_id']),
    handler: async (userId, args, client) => {
      const a = parseArgs(taskUpdateArgs, args);
      const row = await getMemoryRow(userId, a.memory_id);
      if (!row) throw new ToolError(`No memory with id ${a.memory_id}`, 'not_found');
      if (row.type !== 'TASK') throw new ToolError(`Memory ${a.memory_id} is a ${row.type}, not a task`);
      const result: Record<string, unknown> = { memoryId: a.memory_id };
      const reason = utext(a.reason, 'reason');
      if (a.content !== undefined) {
        const content = utext(a.content, 'content')!;
        rejectIfSecret(content);
        const contentHash = sha256(`${row.type}\n${row.title}\n${content}`);
        const version = await withLockedMemory(userId, a.memory_id, async (tx, locked) => {
          const bumped = await tx.query<{ version: number }>(
            `UPDATE memories SET content=$3, summary=$4, content_hash=$5, version=version+1, updated_at=now() WHERE id=$1 AND user_id=$2 RETURNING version`,
            [a.memory_id, userId, content, content.slice(0, 220), contentHash]);
          await addVersion(a.memory_id, bumped.rows[0]!.version, locked.content, locked.status, reason ?? `Task updated via MCP by ${client.id}`, locked.source_id ?? undefined, tx);
          return bumped.rows[0]!.version;
        });
        result.updated = true;
        result.version = version;
      }
      if (a.status !== undefined) {
        const statusResult = await setMemoryStatus(userId, a.memory_id, a.status as MemoryStatus, reason ?? `Task status via MCP by ${client.id}`);
        result.status = statusResult.status;
        result.version = statusResult.version;
      }
      if (result.updated === undefined && result.status === undefined) throw new ToolError('Provide content, status, or both');
      return result;
    }
  },
  {
    name: 'task_status',
    description: 'Set a task\'s status. Explicit only: candidate (recorded), active (in progress), archived (parked), deprecated (obsolete). Tasks are never completed automatically.',
    inputSchema: object({
      memory_id: str('Task memory uuid.'),
      status: str('candidate, active, archived or deprecated.'),
      reason: str('Why the status changed.')
    }, ['memory_id', 'status']),
    handler: async (userId, args, client) => {
      const a = parseArgs(taskStatusArgs, args);
      const row = await getMemoryRow(userId, a.memory_id);
      if (!row) throw new ToolError(`No memory with id ${a.memory_id}`, 'not_found');
      if (row.type !== 'TASK') throw new ToolError(`Memory ${a.memory_id} is a ${row.type}, not a task`);
      const result = await setMemoryStatus(userId, a.memory_id, a.status as MemoryStatus, utext(a.reason, 'reason') ?? `Task status via MCP by ${client.id}`);
      return { updated: true, memoryId: result.id, status: result.status, version: result.version };
    }
  },
  {
    name: 'damc_context',
    description: 'Retrieve relevant shared DAMC memory and the relations between the results, as one context package. Present since DAMC 1.0.0.',
    inputSchema: object({ query: str('Free-text query.'), projectId: str('Optional project uuid.') }, ['query']),
    handler: async (userId, args) => {
      const a = parseArgs(z.object({ query: querySchema, projectId: uuid.optional() }), args);
      return buildContextPackage(userId, a.query, a.projectId);
    }
  },
  {
    name: 'context_pack',
    description:
      'Get a structured Context Pack for a project — active decisions, open tasks, constraints, high-importance memories and recent activity, size-bounded rather than a raw memory dump. Every decision/constraint that was restated by more than one AI client shows every provider that said it, on one merged entry. Unlike damc_context this is not query-driven: it answers "what does DAMC currently know for this project", not "what matches this text".',
    inputSchema: object({ project_id: str('Optional project uuid. Omit for account-wide context.') }),
    handler: async (userId, args) => {
      const a = parseArgs(z.object({ project_id: uuid.optional() }), args);
      return buildContextPack(userId, { projectId: a.project_id });
    }
  },
  {
    name: 'session_start',
    description: 'Begin a DAMC session for a project: returns the full Context Pack (active decisions, open tasks, constraints, important memories, provenance) and a session_id that session_context and session_save reuse, so the project is named once per conversation. Call this before starting work — this is how a new conversation picks up where the last one left off.',
    inputSchema: object({ project_id: str('Project uuid.'), project: str('Project name. One of the two.') }),
    handler: async (userId, args, client) => {
      const a = parseArgs(sessionStartArgs, args);
      const project = await resolveSessionProject(userId, a.project_id, a.project === undefined ? undefined : utext(a.project, 'project'));
      const session = createSession({ userId, projectId: project?.id ?? null, projectHint: project?.name ?? null, client: client.id });
      const pack = await buildContextPack(userId, { projectId: project?.id });
      return {
        session_id: session.id,
        project: project ? { id: project.id, name: project.name } : null,
        context_pack: pack,
        usage:
          'Work with this context. When a decision is settled, call decision_create; for explicit work items call task_create; at the end, call session_save with what mattered. DAMC merges, dedups and supersedes automatically.'
      };
    }
  },
  {
    name: 'session_context',
    description: 'Refresh the working context: the project Context Pack for an open session (or an explicitly named project), plus optional search results for a query. Call mid-conversation when deciding whether something is already known or already decided.',
    inputSchema: object({
      session_id: str('Session id from session_start.'),
      project_id: str('Project uuid, when no session_id is used.'),
      project: str('Project name, when no session_id is used.'),
      query: str('Optional free-text query; results are added alongside the Context Pack.')
    }),
    handler: async (userId, args) => {
      const a = parseArgs(sessionContextArgs, args);
      let projectId = a.project_id;
      let session: { id: string } | null = null;
      if (a.session_id) {
        const stored = getSession(a.session_id, userId);
        if (!stored) throw new ToolError('Unknown or expired session — call session_start again', 'not_found');
        session = { id: stored.id };
        projectId = stored.projectId ?? projectId;
      } else if (!projectId && !a.project && !a.query) {
        throw new ToolError('Provide session_id, project_id, project, or query');
      }
      const resolved = session ? null : await resolveSessionProject(userId, projectId, a.project === undefined ? undefined : utext(a.project, 'project'));
      const pack = await buildContextPack(userId, { projectId: resolved?.id ?? projectId });
      const search = a.query ? await buildContextPackage(userId, a.query, resolved?.id ?? projectId) : undefined;
      return {
        session_id: session?.id ?? null,
        project: resolved ? { id: resolved.id, name: resolved.name } : (projectId ? { id: projectId, name: pack.project?.name ?? '' } : null),
        context_pack: pack,
        ...(search ? { search } : {})
      };
    }
  },
  {
    name: 'session_save',
    description:
      'Save what mattered from this conversation before it ends. Each item goes through DAMC\'s write policy and classification pipeline: clear decisions, tasks and project knowledge are stored (with dedup, supersession and provenance); chatter, questions and speculation are skipped automatically; credentials are refused. This is the write half of the handoff — the next AI calls session_start and sees what was saved.',
    inputSchema: object({
      session_id: str('Session id from session_start.'),
      project_id: str('Project uuid, when no session_id is used.'),
      project: str('Project name, when no session_id is used.'),
      items: { type: 'array', description: 'What to remember: strings or {content, title}. Only things worth sharing.', items: { anyOf: [{ type: 'string' }, { type: 'object', properties: { content: { type: 'string' }, title: { type: 'string' } }, required: ['content'], additionalProperties: false }] }, maxItems: 50 }
    }, ['items']),
    handler: async (userId, args, client) => {
      const a = parseArgs(sessionSaveArgs, args);
      let projectId: string | undefined;
      let projectName: string | undefined;
      if (a.session_id) {
        const stored = getSession(a.session_id, userId);
        if (!stored) throw new ToolError('Unknown or expired session — call session_start again', 'not_found');
        projectId = stored.projectId ?? undefined;
        projectName = stored.projectHint ?? undefined;
      } else {
        const resolved = await resolveSessionProject(userId, a.project_id, a.project === undefined ? undefined : utext(a.project, 'project'));
        projectId = resolved?.id;
        projectName = resolved?.name;
      }
      const saved: Array<{ content: string; status: string; memoriesCreated: number; memoriesSuperseded: number; duplicate: boolean; note?: string }> = [];
      for (const item of a.items) {
        const rawContent = typeof item === 'string' ? item : item.content;
        const rawTitle = typeof item === 'string' ? undefined : item.title;
        // Invalid Unicode is a per-item rejection (like secrets), not a whole-call
        // failure: the note is static text, and the caller's own content is echoed
        // back to nobody but the caller.
        let content: string;
        let title: string | undefined;
        try {
          content = safeText(rawContent, 'items[].content');
          title = rawTitle === undefined ? undefined : safeText(rawTitle, 'items[].title');
        } catch {
          saved.push({ content: rawContent, status: 'rejected', memoriesCreated: 0, memoriesSuperseded: 0, duplicate: false, note: 'Invalid Unicode (lone surrogates) — DAMC cannot store this. Re-send it as valid UTF-8 text.' });
          continue;
        }
        if (!passesAutoRecordBar(content)) {
          saved.push({ content, status: 'skipped', memoriesCreated: 0, memoriesSuperseded: 0, duplicate: false, note: 'Too short to be clearly worth remembering.' });
          continue;
        }
        const scan = scanForSecrets(content);
        if (!scan.clean) {
          saved.push({ content, status: 'rejected', memoriesCreated: 0, memoriesSuperseded: 0, duplicate: false, note: `Looks like ${scan.detail} — DAMC never stores credentials or secrets.` });
          continue;
        }
        const result = await storeViaConversation(userId, client, content, {
          title: title ?? undefined,
          projectHint: projectName,
          via: 'mcp_session'
        });
        const stored = result.memoriesCreated > 0;
        saved.push({
          content,
          status: stored ? 'stored' : 'skipped',
          memoriesCreated: result.memoriesCreated,
          memoriesSuperseded: result.memoriesSuperseded,
          duplicate: result.deduplicated || !stored,
          note: stored ? undefined : 'No clear decision, task or knowledge — DAMC did not store this.'
        });
      }
      return {
        session_id: a.session_id ?? null,
        project: projectId ? { id: projectId, name: projectName ?? '' } : null,
        storedCount: saved.filter(s => s.status === 'stored').length,
        skippedCount: saved.filter(s => s.status === 'skipped').length,
        rejectedCount: saved.filter(s => s.status === 'rejected').length,
        memoriesSuperseded: saved.reduce((n, s) => n + s.memoriesSuperseded, 0),
        items: saved
      };
    }
  },
  {
    name: 'server_info',
    description: 'Describe this DAMC server: version, capabilities, storage and privacy posture.',
    inputSchema: object({}),
    handler: async (userId, _args, client) => {
      const projects = await listProjects(userId);
      return {
        name: 'DAMC',
        product: 'Dalur AI Memory Center',
        version: SERVER_VERSION,
        capabilities: TOOLS.map(t => t.name),
        database: 'local',
        storage: 'PostgreSQL',
        runtime: 'Docker',
        privacy: 'local-first',
        sharedMemory: true,
        projects: projects.map((p: any) => ({ id: p.id, name: p.name })),
        client: { id: client.id, version: client.version }
      };
    }
  },
  {
    name: 'health',
    description: 'Check that DAMC and its database are answering.',
    inputSchema: object({}),
    handler: async (userId) => {
      // Touches the database so this reports real reachability, not just process liveness.
      await listProjects(userId);
      return { ok: true, service: 'damc', version: SERVER_VERSION, database: 'reachable', time: new Date().toISOString() };
    }
  }
];

export const TOOLS_BY_NAME = new Map(TOOLS.map(t => [t.name, t]));
