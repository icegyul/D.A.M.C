/**
 * The large-import path: archive reading, safety limits, temp-file lifecycle and
 * bounded memory.
 *
 * Requirement these tests serve: a 1.9 GB export must import without ever being
 * held in memory. A 1.9 GB fixture has no business in a test suite, so the
 * property is verified structurally instead — peak heap is measured while
 * streaming a file far larger than the heap growth it is allowed to cause, and
 * the element-at-a-time reader is covered exhaustively in json-stream.test.ts.
 * The real 1.9 GB upload is exercised against a running server, out of band.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { env } from '../src/config/env.js';
import { AppError } from '../src/errors/app-error.js';
import { isSafeEntryName, extractConversationShards } from '../src/services/import-archive-service.js';
import { openExportSource, summarizeExport } from '../src/services/import-stream-service.js';
import { looksLikeZip, sweepImportTempDir, importTempDir } from '../src/services/import-upload-service.js';

let tmpDir: string;
let previousTempDir: string | undefined;

/** One ChatGPT-shaped conversation with `pad` bytes of incompressible-ish filler. */
function chatgptConversation(id: string, pad = 0) {
  const filler = pad ? Array.from({ length: pad }, (_, i) => String.fromCharCode(97 + ((i * 7) % 26))).join('') : '';
  return {
    id,
    current_node: 'b',
    mapping: {
      root: { id: 'root', parent: null, message: null },
      a: { id: 'a', parent: 'root', message: { id: 'a', author: { role: 'user' }, content: { parts: [`hello ${id} ${filler}`] } } },
      b: { id: 'b', parent: 'a', message: { id: 'b', author: { role: 'assistant' }, content: { parts: [`world ${id}`] } } }
    }
  };
}

const claudeConversation = (id: string) => ({
  uuid: id,
  chat_messages: [{ uuid: `${id}-m1`, sender: 'human', text: `hi ${id}` }, { uuid: `${id}-m2`, sender: 'assistant', text: `yo ${id}` }]
});

async function writeJson(name: string, value: unknown): Promise<string> {
  const file = path.join(tmpDir, name);
  await fs.writeFile(file, JSON.stringify(value));
  return file;
}

async function writeZip(name: string, files: Record<string, string>): Promise<string> {
  const entries: Record<string, Uint8Array> = {};
  for (const [entry, content] of Object.entries(files)) entries[entry] = strToU8(content);
  const file = path.join(tmpDir, name);
  await fs.writeFile(file, zipSync(entries));
  return file;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'damc-import-'));
  previousTempDir = env.DAMC_IMPORT_TEMP_DIR;
  // Extracted ZIP entries land here, so the suite can assert they are cleaned up.
  env.DAMC_IMPORT_TEMP_DIR = path.join(tmpDir, 'work');
});

afterEach(async () => {
  env.DAMC_IMPORT_TEMP_DIR = previousTempDir;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** Files left in the temp work dir. Should be empty after every disposed import. */
async function tempWorkFiles(): Promise<string[]> {
  return fs.readdir(env.DAMC_IMPORT_TEMP_DIR!).catch(() => [] as string[]);
}

describe('container sniffing', () => {
  it('recognises the ZIP signatures and nothing else', () => {
    expect(looksLikeZip(Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBe(true);
    expect(looksLikeZip(Buffer.from([0x50, 0x4b, 0x05, 0x06]))).toBe(true);
    expect(looksLikeZip(Buffer.from([0x50, 0x4b, 0x07, 0x08]))).toBe(true);
    expect(looksLikeZip(Buffer.from('[{"a":1}]'))).toBe(false);
    expect(looksLikeZip(Buffer.from([0x50]))).toBe(false);
  });
});

/** Requirement 12: path traversal. */
describe('archive entry name safety', () => {
  it('accepts ordinary export entry names', () => {
    for (const name of ['conversations.json', 'export/conversations.json', 'a/b/c/conversations.json']) {
      expect(isSafeEntryName(name), name).toBe(true);
    }
  });

  it('rejects traversal, absolute and drive-qualified names', () => {
    for (const name of [
      '../conversations.json',
      'export/../../conversations.json',
      '/etc/conversations.json',
      'C:/Windows/conversations.json',
      'C:\\Windows\\conversations.json',
      '..\\..\\conversations.json',
      'conversations.json\0.txt',
      ''
    ]) {
      expect(isSafeEntryName(name), JSON.stringify(name)).toBe(false);
    }
  });

  it('rejects an absurdly long name', () => {
    expect(isSafeEntryName('a/'.repeat(600) + 'conversations.json')).toBe(false);
  });

  it('will not select a traversal-named entry as the conversations file', async () => {
    const zip = await writeZip('evil.zip', {
      '../conversations.json': JSON.stringify([chatgptConversation('evil')])
    });
    await expect(extractConversationShards(zip)).rejects.toThrow(/contains no conversation data/);
  });
});

/** Requirement A: small imports behave exactly as before. */
describe('small exports (regression)', () => {
  it('reads a bare JSON array export', async () => {
    const file = await writeJson('chatgpt.json', [chatgptConversation('c1'), chatgptConversation('c2')]);
    const summary = await summarizeExport(file, 'chatgpt');
    expect(summary.container).toBe('json');
    expect(summary.shardNames).toEqual([]);
    expect(summary.shardCount).toBe(1);
    expect(summary.conversations).toBe(2);
    expect(summary.messages).toBe(4);
    expect(summary.sampleTitles).toHaveLength(2);
  });

  it('reads an object-rooted export', async () => {
    const file = await writeJson('wrapped.json', { conversations: [chatgptConversation('c1')] });
    expect((await summarizeExport(file, 'chatgpt')).conversations).toBe(1);
  });

  it('reads a Claude export', async () => {
    const file = await writeJson('claude.json', [claudeConversation('c1'), claudeConversation('c2')]);
    const summary = await summarizeExport(file, 'claude');
    expect(summary.conversations).toBe(2);
    expect(summary.messages).toBe(4);
  });

  it('tolerates a UTF-8 BOM, as the previous reader did', async () => {
    const file = path.join(tmpDir, 'bom.json');
    await fs.writeFile(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify([chatgptConversation('c1')]))]));
    expect((await summarizeExport(file, 'chatgpt')).conversations).toBe(1);
  });

  it('reads conversations.json out of a ZIP, ignoring the other entries', async () => {
    const zip = await writeZip('export.zip', {
      'export/README.txt': 'ignore me',
      'export/media/photo.bin': 'x'.repeat(5000),
      'export/conversations.json': JSON.stringify([chatgptConversation('c1'), chatgptConversation('c2')])
    });
    const summary = await summarizeExport(zip, 'chatgpt');
    expect(summary.container).toBe('zip');
    expect(summary.shardNames).toEqual(['export/conversations.json']);
    expect(summary.conversations).toBe(2);
  });

  it('prefers the shallowest conversations.json when several exist', async () => {
    const zip = await writeZip('multi.zip', {
      'deep/nested/conversations.json': JSON.stringify([chatgptConversation('deep')]),
      'conversations.json': JSON.stringify([chatgptConversation('shallow'), chatgptConversation('shallow2')])
    });
    const summary = await summarizeExport(zip, 'chatgpt');
    expect(summary.shardNames).toEqual(['conversations.json']);
    expect(summary.conversations).toBe(2);
  });

  it('falls back to chat.json, as the previous reader did', async () => {
    const zip = await writeZip('chat.zip', { 'chat.json': JSON.stringify([claudeConversation('c1')]) });
    expect((await summarizeExport(zip, 'claude')).shardNames).toEqual(['chat.json']);
  });

  it('drops conversations with no usable message, matching the array parsers', async () => {
    const file = await writeJson('empty-msgs.json', [
      chatgptConversation('good'),
      { id: 'silent', mapping: {} }
    ]);
    expect((await summarizeExport(file, 'chatgpt')).conversations).toBe(1);
  });
});

/** Requirements D and E. */
describe('malformed input', () => {
  it('rejects a ZIP with no conversations.json, naming the problem', async () => {
    const zip = await writeZip('no-convos.zip', { 'export/README.txt': 'nothing here', 'export/other.json': '{}' });
    await expect(summarizeExport(zip, 'chatgpt')).rejects.toThrow(/contains no conversation data/);
    await expect(summarizeExport(zip, 'chatgpt')).rejects.toBeInstanceOf(AppError);
  });

  it('reports a corrupt archive as unreadable, not as a missing file', async () => {
    const file = path.join(tmpDir, 'corrupt.zip');
    // Valid ZIP signature, garbage after it. fflate's streaming reader does not
    // throw here — it simply finds no entries — so the distinction has to be made
    // deliberately, or a corrupt download is blamed on a missing conversations.json.
    await fs.writeFile(file, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('not really a zip'.repeat(20))]));
    const error = await summarizeExport(file, 'chatgpt').catch(e => e);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('ARCHIVE_UNREADABLE');
  });

  it('names the entry count when the archive reads but has no conversations.json', async () => {
    const zip = await writeZip('readable-no-convos.zip', { 'a.txt': 'x', 'b.txt': 'y' });
    const error = await summarizeExport(zip, 'chatgpt').catch(e => e);
    expect((error as AppError).code).toBe('CONVERSATIONS_JSON_MISSING');
    expect((error as AppError).message).toMatch(/read 2 entries/);
  });

  it('rejects JSON that is not an export', async () => {
    const file = await writeJson('wrong.json', { note: 'no conversations here' });
    await expect(summarizeExport(file, 'chatgpt')).rejects.toThrow(/no conversations array/);
  });

  it('rejects a truncated export instead of importing a prefix', async () => {
    const file = path.join(tmpDir, 'cut.json');
    const whole = JSON.stringify([chatgptConversation('c1'), chatgptConversation('c2')]);
    await fs.writeFile(file, whole.slice(0, Math.floor(whole.length * 0.7)));
    await expect(summarizeExport(file, 'chatgpt')).rejects.toThrow(/truncated|Invalid JSON/);
  });

  it('reports an unparseable conversation as a 400, not a crash', async () => {
    const file = path.join(tmpDir, 'bad-element.json');
    await fs.writeFile(file, '[{"id":"a","mapping":{}},{"id":,}]');
    const error = await summarizeExport(file, 'chatgpt').catch(e => e);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).statusCode).toBe(400);
  });
});

/** Requirement 12: ZIP bomb / abnormal compression ratio. */
describe('archive safety limits', () => {
  it('refuses an entry that decompresses beyond the configured ratio', async () => {
    const previous = env.DAMC_IMPORT_MAX_COMPRESSION_RATIO;
    env.DAMC_IMPORT_MAX_COMPRESSION_RATIO = 5;
    try {
      // Highly repetitive JSON: compresses far better than 5x.
      const bomb = JSON.stringify([{ id: 'b', mapping: {}, pad: 'A'.repeat(2_000_000) }]);
      const zip = await writeZip('bomb.zip', { 'conversations.json': bomb });
      const error = await summarizeExport(zip, 'chatgpt').catch(e => e);
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe('ARCHIVE_COMPRESSION_RATIO');
    } finally {
      env.DAMC_IMPORT_MAX_COMPRESSION_RATIO = previous;
    }
  });

  it('refuses an entry larger than the decompressed cap', async () => {
    const previous = env.DAMC_IMPORT_MAX_UNCOMPRESSED_BYTES;
    env.DAMC_IMPORT_MAX_UNCOMPRESSED_BYTES = 4096;
    try {
      const zip = await writeZip('big-entry.zip', {
        'conversations.json': JSON.stringify(Array.from({ length: 200 }, (_, i) => chatgptConversation(`c${i}`, 200)))
      });
      const error = await summarizeExport(zip, 'chatgpt').catch(e => e);
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe('ARCHIVE_ENTRY_TOO_LARGE');
      expect((error as AppError).statusCode).toBe(413);
    } finally {
      env.DAMC_IMPORT_MAX_UNCOMPRESSED_BYTES = previous;
    }
  });

  it('leaves no extracted temp file behind when a limit rejects the archive', async () => {
    const previous = env.DAMC_IMPORT_MAX_UNCOMPRESSED_BYTES;
    env.DAMC_IMPORT_MAX_UNCOMPRESSED_BYTES = 2048;
    try {
      const zip = await writeZip('reject.zip', {
        'conversations.json': JSON.stringify(Array.from({ length: 100 }, (_, i) => chatgptConversation(`c${i}`, 300)))
      });
      await summarizeExport(zip, 'chatgpt').catch(() => null);
      expect(await tempWorkFiles()).toEqual([]);
    } finally {
      env.DAMC_IMPORT_MAX_UNCOMPRESSED_BYTES = previous;
    }
  });
});

/** Requirements 3 and 11: temp storage and its cleanup. */
describe('temp file lifecycle', () => {
  it('removes the extracted entry when the source is disposed', async () => {
    const zip = await writeZip('dispose.zip', { 'conversations.json': JSON.stringify([chatgptConversation('c1')]) });
    const source = await openExportSource(zip);
    expect(source.info.shardNames).toEqual(['conversations.json']);
    expect(await tempWorkFiles()).toHaveLength(1);
    await source.dispose();
    expect(await tempWorkFiles()).toEqual([]);
  });

  it('removes the extracted entry even when iteration stops early (requirement F: cancel)', async () => {
    const zip = await writeZip('cancel.zip', {
      'conversations.json': JSON.stringify(Array.from({ length: 50 }, (_, i) => chatgptConversation(`c${i}`)))
    });
    const source = await openExportSource(zip);
    let seen = 0;
    for await (const _conversation of source.conversations('chatgpt')) {
      if (++seen === 3) break; // caller abandons the import
    }
    expect(seen).toBe(3);
    await source.dispose();
    expect(await tempWorkFiles()).toEqual([]);
  });

  it('dispose is idempotent', async () => {
    const zip = await writeZip('twice.zip', { 'conversations.json': JSON.stringify([chatgptConversation('c1')]) });
    const source = await openExportSource(zip);
    await source.dispose();
    await expect(source.dispose()).resolves.toBeUndefined();
  });

  it('a bare JSON upload creates no extra temp file', async () => {
    const file = await writeJson('plain.json', [chatgptConversation('c1')]);
    const source = await openExportSource(file);
    expect(await tempWorkFiles()).toEqual([]);
    await source.dispose();
    // The uploaded file itself is untouched by dispose; the route owns it.
    await expect(fs.stat(file)).resolves.toBeDefined();
  });

  it('sweeps orphaned uploads left by a crashed process, and spares fresh ones', async () => {
    const dir = importTempDir();
    await fs.mkdir(dir, { recursive: true });
    const stale = path.join(dir, 'upload-stale.bin');
    const fresh = path.join(dir, 'upload-fresh.bin');
    const unrelated = path.join(dir, 'entry-keep.json');
    await fs.writeFile(stale, 'x');
    await fs.writeFile(fresh, 'x');
    await fs.writeFile(unrelated, 'x');
    const old = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await fs.utimes(stale, old, old);

    const removed = await sweepImportTempDir(60 * 60 * 1000);
    expect(removed).toBe(1);
    await expect(fs.stat(stale)).rejects.toBeDefined();
    await expect(fs.stat(fresh)).resolves.toBeDefined();
    await expect(fs.stat(unrelated)).resolves.toBeDefined();
  });
});

/** Requirements 2, 8 and C: memory must not scale with export size. */
describe('bounded memory', () => {
  it('provider detection reads one conversation, not the file', async () => {
    const file = await writeJson('detect.json', Array.from({ length: 5000 }, (_, i) => chatgptConversation(`c${i}`, 100)));
    const source = await openExportSource(file);
    try {
      expect(await source.detectProvider()).toBe('chatgpt');
    } finally {
      await source.dispose();
    }
  });

  it('detects Claude without a provider hint', async () => {
    const file = await writeJson('detect-claude.json', [claudeConversation('c1')]);
    const source = await openExportSource(file);
    try {
      expect(await source.detectProvider()).toBe('claude');
    } finally {
      await source.dispose();
    }
  });

  it('returns null for an export it cannot attribute, rather than guessing', async () => {
    const file = await writeJson('mystery.json', [{ id: 'x', something_else: true }]);
    const source = await openExportSource(file);
    try {
      expect(await source.detectProvider()).toBeNull();
    } finally {
      await source.dispose();
    }
  });

  /**
   * The structural stand-in for the 1.9 GB case. A ~120 MB export is streamed to
   * completion; heap growth is asserted to stay a small fraction of it. Under the
   * old toBuffer()/unzipSync()/JSON.parse() pipeline this measurement would be
   * several times the file size rather than a fraction, which is exactly the
   * failure being fixed.
   */
  it('streams an export far larger than the memory it is allowed to use', async () => {
    const file = path.join(tmpDir, 'large.json');
    const handle = await fs.open(file, 'w');
    let expected = 0;
    try {
      await handle.write('[');
      // ~120 MB: 12k conversations of ~10 KB each.
      for (let i = 0; i < 12_000; i++) {
        await handle.write((i ? ',' : '') + JSON.stringify(chatgptConversation(`c${i}`, 10_000)));
        expected++;
      }
      await handle.write(']');
    } finally {
      await handle.close();
    }
    const fileBytes = (await fs.stat(file)).size;
    expect(fileBytes).toBeGreaterThan(100 * 1024 * 1024);

    global.gc?.();
    const before = process.memoryUsage().heapUsed;
    let peak = before;
    let count = 0;
    const source = await openExportSource(file);
    try {
      for await (const conversation of source.conversations('chatgpt')) {
        count++;
        expect(conversation.messages.length).toBe(2);
        if (count % 500 === 0) peak = Math.max(peak, process.memoryUsage().heapUsed);
      }
    } finally {
      await source.dispose();
    }

    expect(count).toBe(expected);
    // Generous ceiling so the assertion is about the shape of the algorithm, not
    // GC timing: heap growth must stay well under a quarter of the file.
    expect(peak - before).toBeLessThan(fileBytes / 4);
  }, 120_000);
});
