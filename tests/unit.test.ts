import { describe, it, expect } from 'vitest';
import { sha256 } from '../src/lib/hash.js';
import { GenericExportConnector } from '../src/connectors/generic-export-connector.js';

describe('DAMC core utilities', () => {
  it('produces stable sha256 hashes', () => {
    expect(sha256('abc')).toBe(sha256('abc'));
    expect(sha256('abc')).not.toBe(sha256('abcd'));
  });

  it('normalizes a generic conversation export', async () => {
    const c = new GenericExportConnector('chatgpt');
    const out = await c.importConversationPackage({
      conversations: [{ id: '1', title: 'Test', messages: [{ id:'m1', role:'user', content:'Hello', timestamp:'2026-01-01T00:00:00Z' }] }]
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.provider).toBe('chatgpt');
    expect(out[0]?.messages[0]?.content).toBe('Hello');
  });
});
