import type { ConversationInput } from '../types/domain.js';

/**
 * What a connector can actually do, so the UI can show real buttons instead of
 * guessing. Every field is meant to be checked against the provider's *official*
 * surface before it is ever set to true — see the per-field notes below and
 * docs/COMMON_MEMORY_LAYER.md §"Provider capability model".
 *
 * The original six fields (importHistory .. requiresOfficialAuth) predate this
 * set and are kept for the callers already reading them; the newer fields below
 * are the vocabulary docs/COMMON_MEMORY_LAYER.md and the Connections page use.
 */
export interface ConnectorCapabilities {
  importHistory: boolean;
  incrementalSync: boolean;
  realtimePush: boolean;
  readAccountData: boolean;
  writeBack: boolean;
  requiresOfficialAuth: boolean;

  /** Can a conversation export from this provider be imported at all (file upload / CLI / watch folder)? */
  import: boolean;
  /** Can an operator trigger an import on demand (the three modes above)? Distinct from a provider pushing data on its own. */
  manualSync: boolean;
  /** Does the *provider itself* push or pull updates without a human triggering it? Never true for a file-export-only integration — the watch folder's own automation is reported separately (see WatcherStatus), not folded in here. */
  autoSync: boolean;
  /** Does DAMC hold a live, continuously-updated connection to the provider's account? No provider integrated so far offers this for consumer conversation history. */
  liveSync: boolean;
  /** Can DAMC produce a context pack (project/decisions/tasks/memories) shaped for this provider to read? */
  contextExport: boolean;
  /** Can DAMC push a context pack directly into a provider's conversation? No such API exists for ChatGPT or Claude consumer chat. */
  contextPush: boolean;
  /** Does connecting this provider involve an OAuth/official-auth handshake DAMC performs? False for every export-based connector — there is nothing to authorize because DAMC never touches the account. */
  oauth: boolean;
}

export interface ConversationConnector {
  readonly provider: string;
  capabilities(): ConnectorCapabilities;
  importConversationPackage(input: unknown): Promise<ConversationInput[]>;
  sync(): Promise<{ conversations: ConversationInput[]; cursor?: string }>;
}
