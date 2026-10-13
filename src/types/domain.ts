export type MemoryType =
  | 'PROJECT' | 'CONVERSATION' | 'KNOWLEDGE' | 'DECISION' | 'RESEARCH'
  | 'TASK' | 'EVENT' | 'PERSON' | 'DOCUMENT' | 'PREFERENCE'
  | 'HISTORY' | 'CURRENT_STATE' | 'GOAL' | 'RULE' | 'CONSTRAINT'
  | 'INSIGHT' | 'QUESTION' | 'OPEN_ISSUE' | 'SOURCE' | 'COMMIT';

export type MemoryStatus = 'candidate' | 'confirmed' | 'active' | 'superseded' | 'deprecated' | 'archived';

export type RelationType =
  | 'RELATED_TO' | 'PART_OF' | 'DERIVED_FROM' | 'DECIDED_IN'
  | 'SUPERSEDES' | 'CONFLICTS_WITH' | 'DEPENDS_ON' | 'REFERENCES'
  | 'CREATED_BY' | 'UPDATED_BY';

export interface ConversationMessageInput {
  externalId?: string;
  role: 'system' | 'user' | 'assistant' | 'tool' | 'unknown';
  content: string;
  sequenceNo: number;
  sentAt?: string;
  metadata?: Record<string, unknown>;
}

export interface ConversationInput {
  provider: string;
  externalId: string;
  title?: string;
  startedAt?: string;
  endedAt?: string;
  rawPayload?: unknown;
  messages: ConversationMessageInput[];
  projectHint?: string;
  metadata?: Record<string, unknown>;
}

export interface MemoryCandidate {
  projectHint?: string;
  type: MemoryType;
  title: string;
  content: string;
  summary?: string;
  importance: number;
  confidence: number;
  sourceMessageSequence?: number;
  /**
   * How firmly the source settled this, when DAMC extracted it from prose
   * rather than a caller asserting it. Read by the promotion gate; absent means
   * the caller stated it directly. See services/promotion-gate.ts.
   */
  evidence?: 'explicit' | 'inferred' | null;
  metadata?: Record<string, unknown>;
}
