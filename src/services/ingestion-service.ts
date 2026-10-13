import { query } from '../db/pool.js';
import { env } from '../config/env.js';
import { sha256 } from '../lib/hash.js';
import { findOrCreateProject } from './project-service.js';
import { upsertMemoryCandidate } from './memory-engine.js';
import { classifyMessage } from './text-classification.js';
import type { ConversationInput, MemoryCandidate } from '../types/domain.js';

function normalizeText(s: string): string { return s.replace(/\r\n/g, '\n').replace(/\u0000/g, '').trim(); }

/**
 * Which project an imported conversation belongs to.
 *
 * An explicit `projectHint` on the conversation always wins. Failing that, DAMC
 * looks for a configured keyword in the title or the messages — and a match makes
 * two real changes: it creates a `projects` row with that name, and it promotes
 * that conversation's unclassified prose from HISTORY to KNOWLEDGE.
 *
 * Which is why the keyword list is CONFIGURATION, not a constant. It used to be a
 * hardcoded array holding three of the developer's own project names plus a test
 * string, compiled into every shipped copy. Any user importing a conversation that
 * happened to mention one of them would find a project named after a stranger's
 * work in their own memory database. Nothing about that is the user's data — and
 * the names themselves have no business being in a distributed binary either,
 * which is why they are not repeated here.
 *
 * Read at call time, so an operator can change it without a rebuild.
 */
function projectHintKeywords(): string[] {
  return env.DAMC_PROJECT_HINTS.split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
}

function detectProjectHint(input: ConversationInput): string | undefined {
  if (input.projectHint?.trim()) return input.projectHint.trim();
  const keywords = projectHintKeywords();
  if (!keywords.length) return undefined;
  const haystack = `${input.title ?? ''}\n${input.messages.map(m => m.content).join('\n')}`.toLowerCase();
  return keywords.find(k => haystack.includes(k));
}

export function extractCandidates(input: ConversationInput): MemoryCandidate[] {
  const candidates: MemoryCandidate[] = [];
  const projectHint = detectProjectHint(input);
  for (const m of input.messages) {
    const text = normalizeText(m.content);
    if (!text) continue;
    const signal = classifyMessage(text);
    // Short messages remain filtered out as chat noise, but a message carrying an
    // explicit decision or task is kept regardless of length: Korean directives
    // such as "이걸로 결정했어" sit well under the 30-character floor.
    if (text.length < 30 && !signal.type) continue;
    const looksDecision = signal.type === 'DECISION';
    const looksTask = signal.type === 'TASK';
    const type = looksDecision ? 'DECISION' : looksTask ? 'TASK' : (projectHint ? 'KNOWLEDGE' : 'HISTORY');
    candidates.push({
      projectHint,
      type,
      title: `${type}: ${text.slice(0, 90).replace(/\n/g, ' ')}`,
      content: text,
      summary: text.slice(0, 220),
      importance: looksDecision ? 0.9 : looksTask ? 0.75 : 0.55,
      confidence: 0.55,
      sourceMessageSequence: m.sequenceNo,
      // Every candidate here was extracted from prose, so the promotion gate
      // always gets a grade. An unclassified message (KNOWLEDGE/HISTORY) never
      // settles anything, hence 'inferred'.
      evidence: signal.evidence ?? 'inferred',
      metadata: { heuristic: true, signal: signal.matched }
    });
  }
  return candidates.slice(0, 100);
}

export async function ingestConversation(userId: string, input: ConversationInput) {
  const convHash = sha256(JSON.stringify({ provider: input.provider, externalId: input.externalId, messages: input.messages }));
  const existing = await query<{id:string}>(`SELECT id FROM conversations WHERE user_id=$1 AND provider=$2 AND external_id=$3 LIMIT 1`,
    [userId, input.provider, input.externalId]);
  if (existing.rows[0]) return { conversationId: existing.rows[0].id, deduplicated: true, memoriesCreated: 0, memoriesSuperseded: 0 };

  let projectId: string | undefined;
  const projectHint = detectProjectHint(input);
  if (projectHint) projectId = await findOrCreateProject(userId, projectHint);

  const source = await query<{id:string}>(
    `INSERT INTO sources(user_id,provider,source_type,external_id,title,content_hash,metadata) VALUES($1,$2,'conversation',$3,$4,$5,$6)
     ON CONFLICT(user_id,provider,source_type,external_id) DO UPDATE SET updated_at=now() RETURNING id`,
    [userId, input.provider, input.externalId, input.title ?? null, convHash, input.metadata ?? {}]);

  const conv = await query<{id:string}>(
    `INSERT INTO conversations(user_id,project_id,source_id,provider,external_id,title,started_at,ended_at,raw_payload,content_hash)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [userId, projectId ?? null, source.rows[0]!.id, input.provider, input.externalId, input.title ?? null,
      input.startedAt ?? null, input.endedAt ?? null, input.rawPayload ?? null, convHash]);

  const conversationId = conv.rows[0]!.id;
  for (const m of input.messages) {
    const content = normalizeText(m.content);
    const h = sha256(`${m.role}\n${content}`);
    await query(`INSERT INTO messages(conversation_id,external_id,role,content,sequence_no,sent_at,metadata,content_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(conversation_id,sequence_no) DO NOTHING`,
      [conversationId, m.externalId ?? null, m.role, content, m.sequenceNo, m.sentAt ?? null, m.metadata ?? {}, h]);
  }

  let memoriesCreated = 0;
  let memoriesSuperseded = 0;
  for (const c of extractCandidates(input)) {
    const message = await query<{id:string}>(`SELECT id FROM messages WHERE conversation_id=$1 AND sequence_no=$2 LIMIT 1`, [conversationId, c.sourceMessageSequence ?? 0]);
    const result = await upsertMemoryCandidate({ userId, projectId, candidate: c, sourceId: source.rows[0]!.id, sourceMessageId: message.rows[0]?.id });
    // CONFLICT_PENDING stores a real memory row (as a candidate awaiting
    // review), so it counts as created; it superseded nothing.
    if (result.action === 'CREATE' || result.action === 'SUPERSEDE' || result.action === 'CONFLICT_PENDING') memoriesCreated++;
    if (result.action === 'SUPERSEDE') memoriesSuperseded++;
  }

  await query(`INSERT INTO audit_logs(user_id,action,entity_type,entity_id,details) VALUES($1,'conversation.ingested','conversation',$2,$3)`,
    [userId, conversationId, { provider: input.provider, memoriesCreated }]);

  return { conversationId, deduplicated: false, memoriesCreated, memoriesSuperseded };
}
