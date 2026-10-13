import { unzipSync, strFromU8 } from 'fflate';
import { parseChatGPTExport, parseClaudeExport } from '../connectors/provider-export-parsers.js';
import type { ConversationInput } from '../types/domain.js';

/** ZIP local-file / central-directory / spanning signatures. */
function isZip(bytes: Uint8Array): boolean {
  return bytes.length > 3 && bytes[0] === 0x50 && bytes[1] === 0x4b
    && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07);
}

function findJsonInZip(bytes: Uint8Array): unknown {
  const files = unzipSync(bytes);
  const candidates = Object.entries(files)
    .filter(([name]) => /(^|\/)conversations\.json$/i.test(name) || /(^|\/)(chat|chats)\.json$/i.test(name))
    .sort((a, b) => a[0].length - b[0].length);
  if (!candidates.length) throw new Error('ZIP does not contain conversations.json');
  return JSON.parse(strFromU8(candidates[0]![1]));
}

function parseJsonBytes(bytes: Uint8Array): unknown {
  // Strip a UTF-8 BOM: some provider exports include one and JSON.parse rejects it.
  const text = strFromU8(bytes).replace(/^﻿/, '');
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`File is neither a ZIP archive nor valid JSON: ${e instanceof Error ? e.message : 'parse failed'}`);
  }
}

/**
 * Turns raw upload bytes/string/already-parsed data into the plain export
 * object, without knowing the provider yet. Split out of parseImportPackage so
 * the watch folder can sniff the shape (see detectProvider) before it knows
 * which parser to hand the result to — the file/ZIP/BOM handling stays in one
 * place either way.
 */
export function readImportPayload(payload: unknown): unknown {
  // Uploaded files arrive as a Buffer, which is a Uint8Array. Decide by content,
  // not by type: a JSON upload must not be routed through the ZIP reader.
  if (payload instanceof Uint8Array) {
    return isZip(payload) ? findJsonInZip(payload) : parseJsonBytes(payload);
  }
  if (typeof payload === 'string') return JSON.parse(payload);
  return payload;
}

export function parseImportPackage(provider: 'chatgpt' | 'claude', payload: unknown): ConversationInput[] {
  const data = readImportPayload(payload);
  return provider === 'chatgpt' ? parseChatGPTExport(data) : parseClaudeExport(data);
}
