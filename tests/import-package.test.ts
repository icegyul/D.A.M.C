import { describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { parseImportPackage } from '../src/services/import-package-service.js';

const chatgptExport = [{
  id: 'c1', title: 'Retrieval design', current_node: 'b',
  mapping: {
    root: { id: 'root', parent: null, message: null },
    a: { id: 'a', parent: 'root', message: { id: 'a', author: { role: 'user' }, content: { parts: ['first message'] } } },
    b: { id: 'b', parent: 'a', message: { id: 'b', author: { role: 'assistant' }, content: { parts: ['second message'] } } }
  }
}];

const claudeExport = [{
  uuid: 'c1', name: 'Lifecycle',
  chat_messages: [
    { uuid: 'm1', sender: 'human', text: 'a question' },
    { uuid: 'm2', sender: 'assistant', text: 'an answer' }
  ]
}];

describe('parseImportPackage', () => {
  // Regression: an uploaded file arrives as a Buffer, which is a Uint8Array.
  // Routing every Uint8Array through the ZIP reader made JSON uploads fail
  // with "invalid zip data".
  it('reads raw JSON bytes without treating them as a ZIP', () => {
    const bytes = new Uint8Array(Buffer.from(JSON.stringify(chatgptExport), 'utf8'));
    const out = parseImportPackage('chatgpt', bytes);
    expect(out).toHaveLength(1);
    expect(out[0]?.messages.map(m => m.content)).toEqual(['first message', 'second message']);
  });

  it('reads a Node Buffer of JSON', () => {
    const out = parseImportPackage('claude', Buffer.from(JSON.stringify(claudeExport), 'utf8'));
    expect(out[0]?.messages.map(m => m.role)).toEqual(['user', 'assistant']);
  });

  it('tolerates a UTF-8 BOM', () => {
    const bytes = new Uint8Array(Buffer.from('﻿' + JSON.stringify(claudeExport), 'utf8'));
    expect(parseImportPackage('claude', bytes)).toHaveLength(1);
  });

  it('finds conversations.json inside a ZIP', () => {
    const zip = zipSync({ 'chatgpt-export/conversations.json': strToU8(JSON.stringify(chatgptExport)) });
    const out = parseImportPackage('chatgpt', zip);
    expect(out[0]?.messages).toHaveLength(2);
  });

  it('reports a ZIP without conversations.json', () => {
    const zip = zipSync({ 'export/user.json': strToU8('{}') });
    expect(() => parseImportPackage('chatgpt', zip)).toThrow(/conversations\.json/);
  });

  it('reports a file that is neither ZIP nor JSON', () => {
    const bytes = new Uint8Array(Buffer.from('not json at all', 'utf8'));
    expect(() => parseImportPackage('chatgpt', bytes)).toThrow(/neither a ZIP archive nor valid JSON/);
  });

  it('accepts a JSON string payload', () => {
    expect(parseImportPackage('claude', JSON.stringify(claudeExport))).toHaveLength(1);
  });
});
