/**
 * DAMC memory write policy — what an AI client may store, applied before any
 * engine code runs.
 *
 * The engine (memory-engine.ts) already owns WHAT KIND of memory something is:
 * the classifier decides DECISION/TASK/KNOWLEDGE, dedup drops repeats, and
 * supersession handles conflicts. This module owns a narrower gate that must
 * hold no matter how good the engine gets: obvious credentials and secrets
 * never enter shared memory, from any client, through any tool.
 *
 * Everything here is heuristic and deliberately over-cautious: a false
 * rejection costs the caller one rephrase, while a stored credential sits in
 * shared memory forever.
 */

/** Patterns that look like a credential, token, private key or connection secret. */
const SECRET_PATTERNS: Array<{ id: string; pattern: RegExp; label: string }> = [
  { id: 'pem-private-key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, label: 'a private key block' },
  { id: 'aws-access-key', pattern: /\bAKIA[0-9A-Z]{16}\b/, label: 'an AWS access key id' },
  { id: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/, label: 'a GitHub token' },
  { id: 'openai-style-key', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/, label: 'an OpenAI-style API key' },
  { id: 'anthropic-style-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/, label: 'an Anthropic-style API key' },
  { id: 'slack-token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/, label: 'a Slack token' },
  { id: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/, label: 'a Google API key' },
  { id: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, label: 'a JWT' },
  { id: 'bearer-header', pattern: /\bauthorization\s*[:=]\s*.{12,}/iu, label: 'an Authorization header value' },
  // Assignment-shaped secrets: PASSWORD=..., apiKey: "...", DB_PASS: ...
  // No leading \b on purpose: the common casing is ALL_CAPS_SECRET=…, where
  // "_" and the keyword are both word characters and \b would never fire.
  {
    id: 'secret-assignment',
    pattern: /(?:password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|db[_-]?pass)\b\s*[:=]\s*\S{8,}/iu,
    label: 'a password/token assignment'
  },
  // Connection strings carrying credentials.
  { id: 'connection-string', pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s/:]+:[^\s/]+@/iu, label: 'a connection string with embedded credentials' }
];

export interface SecretScan {
  clean: boolean;
  /** Human-readable description of what tripped the scan, for the rejection message. */
  detail?: string;
  /** Pattern id only — never the matched text, so this is safe to log. */
  patternId?: string;
}

/**
 * Scan text for obvious credentials. Returns the first hit only; one rejection
 * is enough for the caller to fix. Never returns or logs the matched text.
 */
export function scanForSecrets(text: string): SecretScan {
  for (const { id, pattern, label } of SECRET_PATTERNS) {
    if (pattern.test(text)) return { clean: false, detail: label, patternId: id };
  }
  return { clean: true };
}

/**
 * DAMC's auto-record bar for session saves and other bulk writes. Anything a
 * caller marks as worth remembering must still clear the minimum length the
 * ingestion pipeline uses for plain chat noise — the same 30-character floor
 * ingestion-service applies to unclassified messages — so a session dump
 * cannot smuggle one-liner chatter into shared memory.
 */
export const AUTO_RECORD_MIN_LENGTH = 30;

export function passesAutoRecordBar(content: string): boolean {
  return content.trim().length >= AUTO_RECORD_MIN_LENGTH;
}
