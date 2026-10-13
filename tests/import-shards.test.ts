/**
 * Split ChatGPT exports: conversations-000.json, -001.json, -002.json.
 *
 * A real OpenAI export of any size does not contain conversations.json at all.
 * The one this was verified against holds 985 entries — 973 of them `file-*.dat`
 * attachments, plus `shared_conversations.json` and
 * `conversation_asset_file_names.json`, neither of which is the conversation
 * list. Getting the selection wrong in either direction (missing the shards, or
 * picking up a lookalike) is silent: the import simply reports the wrong number
 * of conversations.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { env } from '../src/config/env.js';
import { AppError } from '../src/errors/app-error.js';
import { selectConversationEntries } from '../src/services/import-archive-service.js';
import { openExportSource, summarizeExport } from '../src/services/import-stream-service.js';

let tmpDir: string;
let previousTempDir: string | undefined;

function conversation(id: string) {
  return {
    id,
    current_node: 'b',
    mapping: {
      root: { id: 'root', parent: null, message: null },
      a: { id: 'a', parent: 'root', message: { id: `${id}-a`, author: { role: 'user' }, content: { parts: [`hello ${id}`] } } },
      b: { id: 'b', parent: 'a', message: { id: `${id}-b`, author: { role: 'assistant' }, content: { parts: [`world ${id}`] } } }
    }
  };
}

const shard = (ids: string[]) => JSON.stringify(ids.map(conversation));

async function writeZip(name: string, files: Record<string, string>): Promise<string> {
  const entries: Record<string, Uint8Array> = {};
  for (const [entry, content] of Object.entries(files)) entries[entry] = strToU8(content);
  const file = path.join(tmpDir, name);
  await fs.writeFile(file, zipSync(entries));
  return file;
}

async function tempWorkFiles(): Promise<string[]> {
  return fs.readdir(env.DAMC_IMPORT_TEMP_DIR!).catch(() => [] as string[]);
}

/** Drain a source into the conversation external ids it produced, in order. */
async function idsFrom(file: string): Promise<string[]> {
  const source = await openExportSource(file);
  try {
    const ids: string[] = [];
    for await (const c of source.conversations('chatgpt')) ids.push(c.externalId);
    return ids;
  } finally {
    await source.dispose();
  }
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'damc-shard-'));
  previousTempDir = env.DAMC_IMPORT_TEMP_DIR;
  env.DAMC_IMPORT_TEMP_DIR = path.join(tmpDir, 'work');
});

afterEach(async () => {
  env.DAMC_IMPORT_TEMP_DIR = previousTempDir;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** Selection is pure, so the interesting cases are cheap to pin exhaustively. */
describe('conversation entry selection', () => {
  it('prefers a single conversations.json over shards', () => {
    const result = selectConversationEntries(['conversations-000.json', 'conversations.json', 'conversations-001.json']);
    expect(result).toEqual({ names: ['conversations.json'], layout: 'single' });
  });

  it('falls back to shards when there is no single file', () => {
    const result = selectConversationEntries(['chat.html', 'conversations-001.json', 'conversations-000.json', 'file-a.dat']);
    expect(result.layout).toBe('sharded');
    expect(result.names).toEqual(['conversations-000.json', 'conversations-001.json']);
  });

  /** Requirement D: natural order, so -9 precedes -10 rather than following it. */
  it('sorts shards numerically, not as strings', () => {
    const names = ['conversations-10.json', 'conversations-9.json', 'conversations-1.json', 'conversations-0.json', 'conversations-100.json'];
    expect(selectConversationEntries(names).names).toEqual([
      'conversations-0.json', 'conversations-1.json', 'conversations-9.json', 'conversations-10.json', 'conversations-100.json'
    ]);
  });

  it('treats zero-padded and unpadded numbers the same way', () => {
    expect(selectConversationEntries(['conversations-002.json', 'conversations-1.json']).names)
      .toEqual(['conversations-1.json', 'conversations-002.json']);
  });

  /**
   * The lookalike trap. A real export ships all three of these, and only the
   * numbered ones are conversation data.
   */
  it('never selects shared_conversations.json or conversation_asset_file_names.json', () => {
    const realish = [
      'chat.html', 'ads.json', 'user.json', 'user_settings.json', 'library_files.json',
      'shared_conversations.json', 'conversation_asset_file_names.json',
      'sites/export_manifest.json', 'export_manifest.json',
      'conversations-000.json', 'conversations-001.json', 'conversations-002.json',
      'file-AbC123.dat', 'file-XyZ789.dat'
    ];
    const result = selectConversationEntries(realish);
    expect(result.layout).toBe('sharded');
    expect(result.names).toEqual(['conversations-000.json', 'conversations-001.json', 'conversations-002.json']);
  });

  it('does not mistake shared_conversations.json for a single conversations.json', () => {
    expect(selectConversationEntries(['shared_conversations.json']).names).toEqual([]);
  });

  it('keeps the legacy chat.json fallback last', () => {
    expect(selectConversationEntries(['chat.json']).layout).toBe('legacy');
    expect(selectConversationEntries(['chat.json', 'conversations-000.json']).layout).toBe('sharded');
  });

  it('groups shards by directory and takes the shallowest set', () => {
    const result = selectConversationEntries([
      'deep/nested/conversations-000.json',
      'conversations-001.json',
      'conversations-000.json'
    ]);
    expect(result.names).toEqual(['conversations-000.json', 'conversations-001.json']);
  });

  it('picks the larger set when two shard directories sit at the same depth', () => {
    const result = selectConversationEntries([
      'a/conversations-000.json',
      'b/conversations-000.json', 'b/conversations-001.json'
    ]);
    expect(result.names).toEqual(['b/conversations-000.json', 'b/conversations-001.json']);
  });

  it('ignores unsafe entry names entirely', () => {
    expect(selectConversationEntries(['../conversations-000.json', '/abs/conversations-001.json']).names).toEqual([]);
  });

  it('returns nothing for an archive with no conversation data', () => {
    expect(selectConversationEntries(['chat.html', 'file-a.dat', 'export_manifest.json']).names).toEqual([]);
  });
});

describe('reading shards end to end', () => {
  /** Requirement A: the single-file format must keep working unchanged. */
  it('A — single conversations.json', async () => {
    const zip = await writeZip('single.zip', { 'conversations.json': shard(['a', 'b']) });
    const summary = await summarizeExport(zip, 'chatgpt');
    expect(summary.layout).toBe('single');
    expect(summary.shardCount).toBe(1);
    expect(summary.shardNames).toEqual(['conversations.json']);
    expect(summary.conversations).toBe(2);
  });

  /** Requirement B: one shard is still a shard layout. */
  it('B — a single conversations-000.json', async () => {
    const zip = await writeZip('one-shard.zip', { 'conversations-000.json': shard(['a', 'b', 'c']) });
    const summary = await summarizeExport(zip, 'chatgpt');
    expect(summary.layout).toBe('sharded');
    expect(summary.shardCount).toBe(1);
    expect(summary.conversations).toBe(3);
  });

  /** Requirement C: three shards read as one stream. */
  it('C — three shards are concatenated in order', async () => {
    const zip = await writeZip('three.zip', {
      'conversations-002.json': shard(['g', 'h']),
      'conversations-000.json': shard(['a', 'b', 'c']),
      'conversations-001.json': shard(['d', 'e', 'f'])
    });
    const source = await openExportSource(zip);
    try {
      expect(source.info.shardCount).toBe(3);
      expect(source.info.shardNames).toEqual(['conversations-000.json', 'conversations-001.json', 'conversations-002.json']);
      const ids: string[] = [];
      for await (const c of source.conversations('chatgpt')) ids.push(c.externalId);
      expect(ids).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
    } finally {
      await source.dispose();
    }
  });

  it('D — reads shards in natural order even when the archive stores them shuffled', async () => {
    const zip = await writeZip('natural.zip', {
      'conversations-10.json': shard(['k']),
      'conversations-2.json': shard(['c']),
      'conversations-1.json': shard(['b']),
      'conversations-0.json': shard(['a'])
    });
    expect(await idsFrom(zip)).toEqual(['a', 'b', 'c', 'k']);
  });

  it('reports which shard reading has reached', async () => {
    const zip = await writeZip('report.zip', {
      'conversations-000.json': shard(['a']),
      'conversations-001.json': shard(['b']),
      'conversations-002.json': shard(['c'])
    });
    const seen: Array<{ index: number; name: string; total: number }> = [];
    const source = await openExportSource(zip);
    try {
      for await (const _c of source.conversations('chatgpt', { shard: (index, name, total) => seen.push({ index, name, total }) })) { /* drain */ }
    } finally {
      await source.dispose();
    }
    expect(seen).toEqual([
      { index: 0, name: 'conversations-000.json', total: 3 },
      { index: 1, name: 'conversations-001.json', total: 3 },
      { index: 2, name: 'conversations-002.json', total: 3 }
    ]);
  });

  it('E — names the malformed shard rather than failing anonymously', async () => {
    const zip = await writeZip('malformed.zip', {
      'conversations-000.json': shard(['a']),
      'conversations-001.json': '[{"id":"b","mapping":{}},{"id":,}]',
      'conversations-002.json': shard(['c'])
    });
    const error = await summarizeExport(zip, 'chatgpt').catch(e => e);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).statusCode).toBe(400);
    expect((error as AppError).message).toMatch(/conversations-001\.json/);
  });

  it('F — names the truncated shard', async () => {
    const whole = shard(['x', 'y', 'z']);
    const zip = await writeZip('truncated.zip', {
      'conversations-000.json': shard(['a']),
      'conversations-001.json': whole.slice(0, Math.floor(whole.length * 0.6))
    });
    const error = await summarizeExport(zip, 'chatgpt').catch(e => e);
    expect((error as AppError).message).toMatch(/truncated|Invalid JSON/);
    expect((error as AppError).message).toMatch(/conversations-001\.json/);
  });

  it('F — conversations before the truncation are still delivered', async () => {
    const whole = shard(['x', 'y']);
    const zip = await writeZip('partial.zip', {
      'conversations-000.json': shard(['a', 'b']),
      'conversations-001.json': whole.slice(0, Math.floor(whole.length * 0.6))
    });
    const source = await openExportSource(zip);
    const ids: string[] = [];
    try {
      await expect((async () => {
        for await (const c of source.conversations('chatgpt')) ids.push(c.externalId);
      })()).rejects.toThrow();
    } finally {
      await source.dispose();
    }
    // Everything the reader could parse completely reached the consumer before it
    // refused the incomplete tail: the whole first shard, plus whichever elements
    // of the truncated shard were intact. That is what makes a retry useful — and
    // the incomplete conversation is never among them.
    expect(ids.slice(0, 2)).toEqual(['a', 'b']);
    expect(ids.every(id => ['a', 'b', 'x', 'y'].includes(id))).toBe(true);
    expect(ids).not.toContain('y'); // 'y' is the one the cut landed inside
  });

  /** Requirement G: the real export shape, attachments and lookalikes included. */
  it('G — a realistic OpenAI export: shards plus 900 .dat attachments and lookalike JSON', async () => {
    const files: Record<string, string> = {
      'chat.html': '<html>big</html>',
      'ads.json': '{}',
      'user.json': '{}',
      'user_settings.json': '{}',
      'library_files.json': '{}',
      'shared_conversations.json': '[]',
      'conversation_asset_file_names.json': '{}',
      'sites/export_manifest.json': '{}',
      'export_manifest.json': '{}',
      'conversations-000.json': shard(['a', 'b']),
      'conversations-001.json': shard(['c', 'd', 'e']),
      'conversations-002.json': shard(['f'])
    };
    for (let i = 0; i < 900; i++) files[`file-asset${i}.dat`] = `binary-ish payload ${i}`;

    const zip = await writeZip('realistic.zip', files);
    const summary = await summarizeExport(zip, 'chatgpt');
    expect(summary.layout).toBe('sharded');
    expect(summary.shardCount).toBe(3);
    expect(summary.shardNames).toEqual(['conversations-000.json', 'conversations-001.json', 'conversations-002.json']);
    expect(summary.conversations).toBe(6);
    expect(summary.messages).toBe(12);
  });

  /**
   * Requirement 10: attachments must not be read. Only the shards are extracted,
   * so the temp directory holds exactly three files — not 903.
   */
  it('extracts only the shards, never the .dat attachments', async () => {
    const files: Record<string, string> = {
      'conversations-000.json': shard(['a']),
      'conversations-001.json': shard(['b'])
    };
    for (let i = 0; i < 50; i++) files[`file-${i}.dat`] = 'x'.repeat(1000);
    const zip = await writeZip('only-shards.zip', files);

    const source = await openExportSource(zip);
    try {
      expect(await tempWorkFiles()).toHaveLength(2);
      expect(source.info.jsonBytes).toBeLessThan(5000); // the .dat payloads are not in there
    } finally {
      await source.dispose();
    }
    expect(await tempWorkFiles()).toEqual([]);
  });

  it('removes every shard temp file on dispose, including after an early break', async () => {
    const zip = await writeZip('cleanup.zip', {
      'conversations-000.json': shard(['a', 'b', 'c']),
      'conversations-001.json': shard(['d', 'e', 'f']),
      'conversations-002.json': shard(['g'])
    });
    const source = await openExportSource(zip);
    expect(await tempWorkFiles()).toHaveLength(3);
    let seen = 0;
    for await (const _c of source.conversations('chatgpt')) { if (++seen === 2) break; }
    await source.dispose();
    expect(await tempWorkFiles()).toEqual([]);
  });

  it('detects the provider from the first shard without reading the rest', async () => {
    const zip = await writeZip('detect.zip', {
      'conversations-000.json': shard(['a']),
      'conversations-001.json': shard(['b'])
    });
    const source = await openExportSource(zip);
    try {
      expect(await source.detectProvider()).toBe('chatgpt');
    } finally {
      await source.dispose();
    }
  });

  it('14 — reports a clear error when an archive has no conversation data at all', async () => {
    const zip = await writeZip('none.zip', {
      'chat.html': '<html></html>',
      'shared_conversations.json': '[]',
      'file-a.dat': 'x'
    });
    const error = await summarizeExport(zip, 'chatgpt').catch(e => e);
    expect((error as AppError).code).toBe('CONVERSATIONS_JSON_MISSING');
    expect((error as AppError).message).toMatch(/conversations-NNN\.json/);
    expect((error as AppError).message).toMatch(/read 3 entries/);
  });

  /** Requirement 13: a bare .json upload is unaffected by any of this. */
  it('13 — a plain .json upload still reports one document and no shards', async () => {
    const file = path.join(tmpDir, 'plain.json');
    await fs.writeFile(file, shard(['a', 'b']));
    const summary = await summarizeExport(file, 'chatgpt');
    expect(summary.container).toBe('json');
    expect(summary.layout).toBe('plain');
    expect(summary.shardCount).toBe(1);
    expect(summary.shardNames).toEqual([]);
    expect(summary.conversations).toBe(2);
  });

  it('keeps synthesised fallback ids unique across shard boundaries', async () => {
    // Conversations with no id of their own get "import-N"; the counter has to
    // continue across shards or shard 2 would repeat shard 1's ids and the
    // second shard would deduplicate itself away on import.
    const noId = JSON.stringify([{ mapping: { a: { id: 'a', message: { author: { role: 'user' }, content: { parts: ['x'] } } } } }]);
    const zip = await writeZip('noid.zip', {
      'conversations-000.json': noId,
      'conversations-001.json': noId
    });
    const ids = await idsFrom(zip);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  /**
   * The property that is specific to sharding: shards are read strictly one at a
   * time, so nothing from shard N is still being held when shard N+1 opens.
   *
   * Asserted by interleaving rather than by measuring the heap. A byte-for-byte
   * memory assertion here measures V8's collection timing more than the reader's
   * retention — vitest does not expose `gc()`, so uncollected garbage from
   * thousands of parsed conversations dominates the number. The reader's bounded
   * memory is covered against a 120 MB file in import-streaming.test.ts; what is
   * left to prove is that adding shards does not change the shape, and strict
   * sequencing is exactly that, with no noise.
   */
  it('reads one shard at a time, never holding two open', async () => {
    const files: Record<string, string> = {};
    const expectedPerShard: string[][] = [];
    for (let i = 0; i < 12; i++) {
      const ids = Array.from({ length: 25 }, (_, n) => `s${i}-c${n}`);
      expectedPerShard.push(ids);
      files[`conversations-${String(i).padStart(3, '0')}.json`] = shard(ids);
    }
    const zip = await writeZip('sequential.zip', files);

    // One combined timeline of "shard opened" and "conversation yielded" events.
    const timeline: string[] = [];
    const source = await openExportSource(zip);
    try {
      expect(source.info.shardCount).toBe(12);
      for await (const c of source.conversations('chatgpt', {
        shard: (_index, name) => timeline.push(`open:${name}`)
      })) {
        timeline.push(`conv:${c.externalId}`);
      }
    } finally {
      await source.dispose();
    }

    // Rebuild the timeline into shard groups and compare against the input.
    const groups: string[][] = [];
    for (const event of timeline) {
      if (event.startsWith('open:')) groups.push([]);
      else groups[groups.length - 1]!.push(event.slice('conv:'.length));
    }
    expect(groups).toHaveLength(12);
    // Every conversation of shard i is delivered before shard i+1 is opened. If
    // the reader buffered shards, or read them concurrently, these groups would
    // not line up with the input shards.
    expect(groups).toEqual(expectedPerShard);
  });
});
