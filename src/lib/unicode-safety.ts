/**
 * Unicode safety for anything an AI client sends us.
 *
 * JavaScript strings can hold lone UTF-16 surrogates (and JSON can carry them
 * as \uD800 escapes). PostgreSQL runs in UTF-8 and rejects such text at
 * INSERT time — without a guard that surfaces as a generic 500, and a naive
 * "fix" that guesses at the intended characters would corrupt memory silently.
 *
 * Policy, applied at every MCP write entry point through `safeText`:
 *   1. Lone surrogates (or any unpaired surrogate pair) are REJECTED with a
 *      client-readable error that names the field, never the content — the
 *      content may hold secrets and is never echoed or logged.
 *   2. Valid text is returned NFC-normalized so cross-client dedup and hashing
 *      are encoding-stable (NFD jamo vs NFC syllables must not fork a memory).
 *
 * Normal Korean/English/Japanese/emoji pass through byte-identical in meaning
 * (NFC is a no-op for already-composed text, which is what well-behaved
 * clients send). Nothing here guesses, translates, or repairs content.
 */

const LONE_HIGH_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/;
const LONE_LOW_SURROGATE = /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** True when the string cannot be encoded as valid UTF-8 (lone surrogates). */
export function hasInvalidUnicode(text: string): boolean {
  return LONE_HIGH_SURROGATE.test(text) || LONE_LOW_SURROGATE.test(text);
}

/**
 * Validate and normalize one free-text field. Returns NFC text ready to hash
 * and store. Throws a plain Error carrying only the field name — callers map
 * it to their own error shape (ToolError for MCP, AppError elsewhere) so this
 * module stays dependency-free and no layer can forget the mapping.
 */
export function safeText(text: string, field: string): string {
  if (typeof text !== 'string') throw new Error(`Invalid ${field}: expected text`);
  if (hasInvalidUnicode(text)) {
    throw new Error(
      `Invalid Unicode in ${field}: the text contains lone surrogates and cannot be stored. Re-send it as valid UTF-8 text.`
    );
  }
  return text.normalize('NFC');
}

/** Validate every string in a list (session_save items, bulk fields). */
export function safeTexts(texts: string[], field: string): string[] {
  return texts.map(t => safeText(t, field));
}

/**
 * Truncate to at most `maxLength` characters without ever splitting a surrogate
 * pair. Plain `String.slice` counts UTF-16 code units, so cutting an emoji (or
 * any astral character) at a title/summary boundary leaves a lone surrogate —
 * valid in no encoding, fatal for strict JSON clients, rendered as mojibake
 * everywhere else. Spreading iterates code points, so the cut always lands on a
 * character boundary. BMP text (Korean/English/Japanese) is unaffected.
 */
export function truncateSafe(text: string, maxLength: number): string {
  if (maxLength < 0) return '';
  const chars = [...text];
  return chars.length <= maxLength ? text : chars.slice(0, maxLength).join('');
}
