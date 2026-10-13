/**
 * MCP response Unicode serialization — regression pins.
 *
 * The JSON path (repository → context pack → MCP tool result → JSON-RPC) is a
 * pure pass-through: nothing may transform, drop, or split characters between
 * the database and the AI client. These tests pin that contract at unit level:
 *
 *  - Korean / English / Japanese / emoji / mixed payloads survive a strict
 *    JSON round-trip byte-identical (strict parsing rejects lone surrogates).
 *  - session_start / context_pack / memory_get shaped payloads serialize clean.
 *  - Title/summary truncation never splits a surrogate pair (the one place the
 *    response path used to cut UTF-16 code units).
 *
 * Live byte-exact checks against the real endpoint complement (not replace)
 * these: strict-parse all four responses, zero lone surrogates, Korean bytes
 * identical to the database row.
 */
import { describe, it, expect } from 'vitest';
import { hasInvalidUnicode, truncateSafe } from '../src/lib/unicode-safety.js';
import { formatContextPackAsText } from '../src/services/context-pack-service.js';

const KR = '백업 방식을 매주 일요일 증분 백업으로 변경하기로 했다';
const EN = 'Deployment method for EARTHUS is Docker';
const JP = 'デプロイ方式はDockerに決定';
const EMOJI = 'Ship it 🚀 done ✅';
const MIXED = `${KR} / ${EN} / ${JP} ${EMOJI}`;

/** Strict round-trip: byte-identical out, and no lone surrogate anywhere. */
function assertRoundTrip(value: unknown): string {
  const json = JSON.stringify(value);
  expect(hasInvalidUnicode(json)).toBe(false);
  const back = JSON.parse(json) as unknown;
  expect(back).toEqual(value);
  expect(JSON.stringify(back)).toBe(json);
  return json;
}

describe('response payloads serialize clean', () => {
  it.each([
    ['korean', KR],
    ['english', EN],
    ['japanese', JP],
    ['emoji', EMOJI],
    ['mixed', MIXED]
  ])('%s survives a strict JSON round-trip byte-identical', (_label, text) => {
    assertRoundTrip({ content: text, title: `DECISION: ${text}`, summary: text });
  });

  it('a session_start-shaped payload serializes clean', () => {
    assertRoundTrip({
      session_id: 'abc123',
      project: { id: '00000000-0000-0000-0000-000000000001', name: 'EARTHUS' },
      context_pack: {
        activeDecisions: [{ content: KR, providers: ['claude-code'] }, { content: EN, providers: ['cursor'] }],
        activeTasks: [{ content: 'API 게이트웨이 구현', providers: ['cursor'] }],
        constraints: [],
        usage: 'Work with this context.'
      }
    });
  });

  it('a context_pack-shaped payload serializes clean', () => {
    assertRoundTrip({
      version: 'damc-context-pack-v1',
      project: { name: 'EARTHUS' },
      activeDecisions: [{ content: MIXED }],
      counts: { activeDecisions: 1, activeTasks: 0 }
    });
  });

  it('a memory_get-shaped payload with versions and relations serializes clean', () => {
    assertRoundTrip({
      memory: {
        content: KR,
        versions: [{ content: '백업 방식은 매일 자정 전체 백업으로 결정했다', changeReason: 'Superseded by newer memory' }],
        relations: [{ relationType: 'SUPERSEDES' }],
        provenance: { provider: 'cursor', sourceTitle: 'MCP decision by cursor' }
      }
    });
  });

  it('plain-text context rendering preserves every script', () => {
    const text = formatContextPackAsText({
      version: 'damc-context-pack-v1',
      generatedAt: new Date().toISOString(),
      project: { id: 'p', name: 'EARTHUS', slug: 'ear thus', description: null },
      activeDecisions: [
        { id: '1', type: 'DECISION', title: KR, content: KR, summary: KR, status: 'active', importance: 0.9, confidence: 0.85, updatedAt: '', provider: 'cursor', providers: ['cursor', 'claude-code'], crossProvider: true, provenance: { primary: {}, restatedBy: [] } },
        { id: '2', type: 'DECISION', title: EN, content: EN, summary: EN, status: 'active', importance: 0.9, confidence: 0.85, updatedAt: '', provider: 'cursor', providers: ['cursor'], crossProvider: false, provenance: { primary: {}, restatedBy: [] } }
      ],
      activeTasks: [],
      constraints: [],
      importantMemories: [{ id: '3', type: 'KNOWLEDGE', title: JP, content: JP, summary: JP, status: 'active', importance: 0.8, confidence: 0.8, updatedAt: '', provider: 'grok', providers: ['grok'], crossProvider: false, provenance: { primary: {}, restatedBy: [] } }],
      recentContext: [{ id: '4', type: 'KNOWLEDGE', title: EMOJI, content: EMOJI, summary: EMOJI, status: 'active', importance: 0.5, confidence: 0.5, updatedAt: '', provider: 'cursor', providers: ['cursor'], crossProvider: false, provenance: { primary: {}, restatedBy: [] } }]
    } as any);
    for (const expected of [KR, EN, JP, EMOJI]) expect(text).toContain(expected);
    expect(hasInvalidUnicode(text)).toBe(false);
    assertRoundTrip({ text });
  });
});

describe('truncateSafe (response title/summary cuts)', () => {
  it('never splits a surrogate pair at the boundary', () => {
    // 89 BMP chars + emoji: a UTF-16 slice(0, 90) would keep the lone high surrogate.
    const text = `${'a'.repeat(89)}🚀tail`;
    expect(text.slice(0, 90)).not.toBe(truncateSafe(text, 90));
    const cut = truncateSafe(text, 90);
    expect(hasInvalidUnicode(cut)).toBe(false);
    // 90 code points: the 89 a's plus the whole emoji, never a half of it.
    expect(cut).toBe(`${'a'.repeat(89)}🚀`);
    expect([...cut].length).toBeLessThanOrEqual(90);
  });

  it('keeps BMP text (Korean/English/Japanese) identical to slice', () => {
    for (const text of [KR, EN, JP, MIXED]) {
      expect(truncateSafe(text, 90)).toBe(text.slice(0, 90));
      expect(truncateSafe(text, 220)).toBe(text);
    }
  });

  it('handles edges', () => {
    expect(truncateSafe('', 10)).toBe('');
    expect(truncateSafe('abc', 0)).toBe('');
    expect(truncateSafe('abc', -1)).toBe('');
  });

  it('rejects lone surrogates rather than truncating around them', () => {
    // Detection belongs to safeText (write path); the response scanner agrees.
    // Built via fromCharCode so the source stays pure ASCII — no literal that
    // any editor, console, or transport layer could normalize away.
    // Note: the JSON *encoding* of a lone surrogate is plain ASCII (an escape
    // of six characters) — the danger materializes when a client parses it back.
    const lone = 'ok ' + String.fromCharCode(0xd800) + ' text';
    expect(hasInvalidUnicode(lone)).toBe(true);
    const parsed = JSON.parse(JSON.stringify({ t: lone })) as { t: string };
    expect(hasInvalidUnicode(parsed.t)).toBe(true);
  });
});
