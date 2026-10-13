import type { ConversationInput, ConversationMessageInput } from '../types/domain.js';

function record(v: unknown): Record<string, any> { return typeof v === 'object' && v !== null ? v as Record<string, any> : {}; }
function textFromContent(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(x => textFromContent(x)).filter(Boolean).join('\n');
  const r = record(v);
  if (typeof r.text === 'string') return r.text;
  if (Array.isArray(r.parts)) return r.parts.map((x: unknown) => textFromContent(x)).filter(Boolean).join('\n');
  if (Array.isArray(r.content)) return r.content.map((x: unknown) => textFromContent(x)).filter(Boolean).join('\n');
  return '';
}

function normalizeRole(v: unknown): ConversationMessageInput['role'] {
  const role = String(v ?? '').toLowerCase();
  if (role === 'human') return 'user';
  if (role === 'assistant') return 'assistant';
  if (role === 'system') return 'system';
  if (role === 'tool') return 'tool';
  if (role === 'user') return 'user';
  return 'unknown';
}

/**
 * One ChatGPT conversation. Split out of parseChatGPTExport so the streaming
 * importer can convert conversations as they arrive off the JSON reader instead
 * of materialising the whole export array first — a 1.9 GB export has no array
 * small enough to hold. Returns null when the conversation carries no usable
 * message, which is what the array form filters out.
 */
export function parseChatGPTConversation(raw: unknown, index: number): ConversationInput | null {
  const list = parseChatGPTExport([raw], index);
  return list[0] ?? null;
}

export function parseChatGPTExport(input: unknown, indexOffset = 0): ConversationInput[] {
  const root: unknown[] = Array.isArray(input) ? input : (Array.isArray(record(input).conversations) ? record(input).conversations as unknown[] : []);
  return root.flatMap((raw: unknown, position: number): ConversationInput[] => {
    const index = position + indexOffset;
    const c = record(raw);
    const mapping = record(c.mapping);
    const nodes = Object.values(mapping).map(record);
    // Prefer the visible path ending at current_node. If unavailable, fall back to node insertion order.
    const byId = new Map(nodes.filter(n => n.id).map(n => [n.id, n]));
    const ordered: any[] = [];
    const seen = new Set<string>();
    let current = typeof c.current_node === 'string' ? byId.get(c.current_node) : undefined;
    while (current && !seen.has(String(current.id))) {
      seen.add(String(current.id)); ordered.push(current);
      current = typeof current.parent === 'string' ? byId.get(current.parent) : undefined;
    }
    ordered.reverse();
    const sourceNodes = ordered.length ? ordered : nodes;
    const messages: ConversationMessageInput[] = sourceNodes.map((node, i) => {
      const msg = record(node.message);
      const content = textFromContent(msg.content);
      return {
        externalId: typeof msg.id === 'string' ? msg.id : typeof node.id === 'string' ? node.id : `${index}-${i}`,
        role: normalizeRole(record(msg.author).role),
        content,
        sequenceNo: i,
        sentAt: typeof msg.create_time === 'number' ? new Date(msg.create_time * 1000).toISOString() : typeof msg.create_time === 'string' ? msg.create_time : undefined,
        metadata: { model: record(msg.metadata).model_slug, nodeId: node.id, parentId: node.parent }
      };
    }).filter(m => m.content.trim());
    return [{
      provider: 'chatgpt',
      externalId: typeof c.id === 'string' ? c.id : `import-${index + 1}`,
      title: typeof c.title === 'string' ? c.title : undefined,
      startedAt: toDate(c.create_time),
      endedAt: toDate(c.update_time),
      rawPayload: raw,
      messages,
      projectHint: undefined,
      metadata: { importer: 'chatgpt-export-v1' }
    }];
  }).filter((c: ConversationInput) => c.messages.length);
}

/** One Claude conversation. Same reason as parseChatGPTConversation above. */
export function parseClaudeConversation(raw: unknown, index: number): ConversationInput | null {
  const list = parseClaudeExport([raw], index);
  return list[0] ?? null;
}

export function parseClaudeExport(input: unknown, indexOffset = 0): ConversationInput[] {
  const root: unknown[] = Array.isArray(input) ? input : (Array.isArray(record(input).conversations) ? record(input).conversations as unknown[] : []);
  return root.flatMap((raw: unknown, position: number): ConversationInput[] => {
    const index = position + indexOffset;
    const c = record(raw);
    const source = Array.isArray(c.chat_messages) ? c.chat_messages : [];
    const messages: ConversationMessageInput[] = source.map((rawMessage: unknown, i: number) => {
      const m = record(rawMessage);
      return {
        externalId: typeof m.uuid === 'string' ? m.uuid : `${index}-${i}`,
        role: normalizeRole(m.sender),
        content: textFromContent(m.text ?? m.content),
        sequenceNo: i,
        sentAt: typeof m.created_at === 'string' ? m.created_at : undefined,
        metadata: { projectUuid: m.project_uuid ?? c.project_uuid, updatedAt: m.updated_at }
      };
    }).filter((m: ConversationMessageInput) => m.content.trim());
    return [{
      provider: 'claude',
      externalId: typeof c.uuid === 'string' ? c.uuid : `import-${index + 1}`,
      title: typeof c.name === 'string' ? c.name : undefined,
      startedAt: typeof c.created_at === 'string' ? c.created_at : undefined,
      endedAt: typeof c.updated_at === 'string' ? c.updated_at : undefined,
      rawPayload: raw,
      messages,
      projectHint: undefined,
      metadata: { importer: 'claude-export-v1', projectUuid: c.project_uuid }
    }];
  }).filter((c: ConversationInput) => c.messages.length);
}

function toDate(v: unknown) {
  if (typeof v === 'number') return new Date(v * 1000).toISOString();
  return typeof v === 'string' ? v : undefined;
}

/**
 * Best-effort provider guess from export shape, used only where nobody can be
 * asked (the watch folder). A ChatGPT export's conversations carry a `mapping`
 * node graph; a Claude export's carry a `chat_messages` array. Returns null
 * rather than guessing when neither shape is recognized, so a watched file is
 * never run through the wrong provider's parser.
 */
export function detectProvider(data: unknown): 'chatgpt' | 'claude' | null {
  const root: unknown[] = Array.isArray(data) ? data : (Array.isArray(record(data).conversations) ? record(data).conversations as unknown[] : []);
  const first = record(root[0]);
  if (first.mapping && typeof first.mapping === 'object') return 'chatgpt';
  if (Array.isArray(first.chat_messages)) return 'claude';
  return null;
}
