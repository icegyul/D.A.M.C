import type { ConversationConnector, ConnectorCapabilities } from './types.js';
import type { ConversationInput, ConversationMessageInput } from '../types/domain.js';
import { parseChatGPTExport, parseClaudeExport } from './provider-export-parsers.js';

function asRecord(v: unknown): Record<string, any> { return typeof v === 'object' && v !== null ? v as Record<string, any> : {}; }
function normalizeRole(v: unknown): ConversationMessageInput['role'] {
  const role = String(v ?? '').toLowerCase();
  if (['system','user','assistant','tool'].includes(role)) return role as ConversationMessageInput['role'];
  if (role === 'human') return 'user';
  return 'unknown';
}

export class GenericExportConnector implements ConversationConnector {
  constructor(public readonly provider: string) {}
  capabilities(): ConnectorCapabilities {
    return {
      importHistory: true, incrementalSync: false, realtimePush: false, readAccountData: false, writeBack: false, requiresOfficialAuth: true,
      // Every export-based connector (ChatGPT, Claude) shares this shape: file
      // import through three modes, no provider-side push of any kind, and no
      // account authorization because DAMC never touches the account.
      import: true, manualSync: true, autoSync: false, liveSync: false,
      contextExport: true, contextPush: false, oauth: false
    };
  }
  async importConversationPackage(input: unknown): Promise<ConversationInput[]> {
    if (this.provider === 'chatgpt') {
      const parsed = parseChatGPTExport(input);
      if (parsed.length) return parsed;
    }
    if (this.provider === 'claude') {
      const parsed = parseClaudeExport(input);
      if (parsed.length) return parsed;
    }
    const root = Array.isArray(input) ? input : (Array.isArray(asRecord(input).conversations) ? asRecord(input).conversations : [input]);
    const out: ConversationInput[] = [];
    for (const raw of root) {
      const r = asRecord(raw);
      const messagesRaw = Array.isArray(r.messages) ? r.messages : Array.isArray(r.chat_messages) ? r.chat_messages : [];
      const messages: ConversationMessageInput[] = messagesRaw.map((m: unknown, i: number) => {
        const x = asRecord(m);
        return {
          externalId: typeof x.id === 'string' ? x.id : typeof x.uuid === 'string' ? x.uuid : undefined,
          role: normalizeRole(x.role ?? x.sender),
          content: typeof x.content === 'string' ? x.content : typeof x.text === 'string' ? x.text : JSON.stringify(x.content ?? x.text ?? ''),
          sequenceNo: i,
          sentAt: typeof x.created_at === 'string' ? x.created_at : typeof x.timestamp === 'string' ? x.timestamp : undefined,
          metadata: x.metadata && typeof x.metadata === 'object' ? x.metadata : undefined
        };
      });
      const externalId = typeof r.id === 'string' ? r.id : typeof r.uuid === 'string' ? r.uuid : `import-${out.length + 1}`;
      out.push({ provider: this.provider, externalId, title: typeof r.title === 'string' ? r.title : typeof r.name === 'string' ? r.name : undefined, rawPayload: raw, messages });
    }
    return out.filter(x => x.messages.length);
  }
  async sync() { return { conversations: [] as ConversationInput[] }; }
}
