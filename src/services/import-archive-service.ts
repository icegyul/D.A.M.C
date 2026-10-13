/**
 * Pulling the conversation data out of an uploaded export ZIP, without unpacking
 * the archive.
 *
 * The previous implementation called fflate's `unzipSync`, which decompresses
 * *every* entry into memory at once and returns them as a map. A real ChatGPT
 * export is mostly attached media — 973 of the 985 entries in the export this was
 * verified against are `file-*.dat` — so that inflated hundreds of megabytes of
 * files DAMC has no use for, on top of the JSON it actually wanted.
 *
 * This streams the archive through fflate's push-based `Unzip` instead and calls
 * `start()` on only the conversation entries. Entries that are never started are
 * never decompressed, so the media is skipped at the cost of reading past it.
 *
 * SHARDED EXPORTS. OpenAI does not necessarily ship one conversations.json. A
 * large account exports the conversations split across numbered shards —
 * conversations-000.json, conversations-001.json, conversations-002.json — and no
 * conversations.json at all. Looking only for the single name is what made a real
 * 1.9 GB export report "the ZIP does not contain conversations.json". All shards
 * of the chosen set are extracted, each to its own temp file, and the reader
 * above concatenates them as one conversation stream — they are never merged into
 * one file or one buffer.
 */

import fs from 'node:fs/promises';
import { createWriteStream, type WriteStream } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Unzip, UnzipInflate } from 'fflate';
import { env } from '../config/env.js';
import { AppError } from '../errors/app-error.js';
import { importTempDir } from './import-upload-service.js';

/**
 * Entry names DAMC accepts as conversation data.
 *
 * Each is anchored on `(^|\/)`, which is load-bearing: a real export also
 * contains `shared_conversations.json` and `conversation_asset_file_names.json`.
 * Without the anchor, `shared_conversations.json` would be picked up as the
 * conversation list — it is 229 bytes of something else entirely.
 */
const SINGLE_ENTRY = /(^|\/)conversations\.json$/i;
const SHARD_ENTRY = /(^|\/)conversations-(\d+)\.json$/i;
const LEGACY_ENTRY = /(^|\/)(chat|chats)\.json$/i;

/** A real export has a few thousand media files; far beyond that is not an export. */
const MAX_ENTRIES = 500_000;

/**
 * Reject an entry name that tries to escape its directory.
 *
 * DAMC never joins an archive name onto a filesystem path — every extracted entry
 * is written to a generated temp name — so traversal cannot actually happen here.
 * The check stays because matching a *name* against a pattern is a decision, and
 * an archive shipping `../../conversations.json` is not one to read conversations
 * out of.
 */
export function isSafeEntryName(name: string): boolean {
  if (!name || name.length > 1024) return false;
  if (name.includes('\0')) return false;
  const normalized = name.replace(/\\/g, '/');
  if (normalized.startsWith('/')) return false;
  if (/^[a-zA-Z]:/.test(normalized)) return false;
  return !normalized.split('/').includes('..');
}

export type ExportLayout = 'single' | 'sharded' | 'legacy';

export interface ExtractedShard {
  /** Temp file holding the decompressed shard. */
  path: string;
  /** Entry name inside the archive. */
  name: string;
  bytes: number;
}

export interface ExtractedShards {
  shards: ExtractedShard[];
  layout: ExportLayout;
  cleanup: () => Promise<void>;
}

interface Classified {
  name: string;
  dir: string;
  /** Shard index parsed from the filename; null for single/legacy layouts. */
  shardIndex: number | null;
}

function directoryOf(name: string): string {
  const slash = name.lastIndexOf('/');
  return slash === -1 ? '' : name.slice(0, slash);
}

/**
 * Choose which entries hold the conversations.
 *
 * Preference order — single file, then a shard set, then the legacy chat.json —
 * so an export that somehow contains both keeps the behaviour it had before
 * sharding was supported.
 *
 * Shards are grouped by directory because two directories of shards are two
 * different exports, not one set; the shallowest group wins, matching how the
 * single-file case already preferred the shallowest path. Within a group the
 * shards are sorted by their parsed number, not by string, so
 * conversations-9.json precedes conversations-10.json.
 */
export function selectConversationEntries(names: string[]): { names: string[]; layout: ExportLayout } {
  const safe = names.filter(isSafeEntryName);

  const singles = safe.filter(n => SINGLE_ENTRY.test(n))
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  if (singles.length) return { names: [singles[0]!], layout: 'single' };

  const shards: Classified[] = [];
  for (const name of safe) {
    const match = SHARD_ENTRY.exec(name);
    if (match) shards.push({ name, dir: directoryOf(name), shardIndex: Number(match[2]) });
  }
  if (shards.length) {
    const groups = new Map<string, Classified[]>();
    for (const shard of shards) {
      const group = groups.get(shard.dir) ?? [];
      group.push(shard);
      groups.set(shard.dir, group);
    }
    const chosen = [...groups.entries()].sort((a, b) => {
      const depth = (a[0] === '' ? 0 : a[0].split('/').length) - (b[0] === '' ? 0 : b[0].split('/').length);
      if (depth !== 0) return depth;
      // A deeper tie breaks toward the larger set, then alphabetically, so the
      // choice is deterministic rather than dependent on archive order.
      if (a[1].length !== b[1].length) return b[1].length - a[1].length;
      return a[0].localeCompare(b[0]);
    })[0]![1];
    chosen.sort((a, b) => (a.shardIndex! - b.shardIndex!) || a.name.localeCompare(b.name));
    return { names: chosen.map(s => s.name), layout: 'sharded' };
  }

  const legacy = safe.filter(n => LEGACY_ENTRY.test(n))
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  if (legacy.length) return { names: [legacy[0]!], layout: 'legacy' };

  return { names: [], layout: 'single' };
}

/**
 * Stream `zipPath` and write every conversation shard to its own temp file.
 *
 * Two passes, because a streaming reader cannot seek and the entries DAMC wants
 * may be anywhere in the archive:
 *   1. read entry names only (nothing is decompressed) and choose the set;
 *   2. read again, decompressing only those entries.
 *
 * Reading a multi-gigabyte file twice costs disk throughput, not memory, and it
 * buys a guarantee worth having: the archive is known to contain conversation
 * data before a single row is written to the database.
 */
export async function extractConversationShards(zipPath: string): Promise<ExtractedShards> {
  const { names, entryCount } = await listEntryNames(zipPath);
  const selection = selectConversationEntries(names);

  if (!selection.names.length) {
    // Zero entries at all means the archive itself did not read, not that it is
    // an export missing a file. fflate's streaming reader does not throw on a
    // file that merely starts with a ZIP signature, so without this distinction a
    // truncated or corrupt download would be reported as "no conversations.json"
    // and send the user looking for the wrong problem.
    if (entryCount === 0) {
      throw new AppError(
        'ARCHIVE_UNREADABLE',
        'The uploaded file starts like a ZIP but no entries could be read from it. The download may be incomplete or corrupt — try exporting again.',
        400
      );
    }
    throw new AppError(
      'CONVERSATIONS_JSON_MISSING',
      `The ZIP contains no conversation data (read ${entryCount} entr${entryCount === 1 ? 'y' : 'ies'}, but none named conversations.json or conversations-NNN.json). Upload the export archive the provider gave you, or a conversations.json from inside it.`,
      400
    );
  }

  return extractNamedEntries(zipPath, selection.names, selection.layout);
}

/** Pass 1: entry names only. `start()` is never called, so nothing is inflated. */
async function listEntryNames(zipPath: string): Promise<{ names: string[]; entryCount: number }> {
  const inspected = await inspectArchiveEntries(zipPath);
  return { names: inspected.entries.map(e => e.name), entryCount: inspected.entryCount };
}

export interface ArchiveEntryInfo {
  name: string;
  /** Compressed size from the entry header, 0 when the archive does not declare one. */
  compressedBytes: number;
  /** Uncompressed size from the entry header. A header can lie; this is a hint. */
  declaredBytes: number;
}

export interface ArchiveInspection {
  entries: ArchiveEntryInfo[];
  entryCount: number;
  /** True when `entries` was capped and does not list everything in the archive. */
  truncated: boolean;
}

/**
 * List what is inside an archive without decompressing any of it.
 *
 * This is the *evidence-gathering* primitive for a Claude export category DAMC
 * has no parser for. The rule those categories are held to is that DAMC does not
 * invent a field mapping for a structure it has not seen — so instead of guessing,
 * it records the archive's real entry names and sizes onto the job. That record is
 * what a future mapping gets written against, and it costs one pass over the
 * central directory rather than a decompression.
 *
 * `start()` is never called on any entry, so nothing is inflated; a 2 GB archive
 * of media costs a read and a list of names.
 */
export async function inspectArchiveEntries(zipPath: string, limit = 200): Promise<ArchiveInspection> {
  const entries: ArchiveEntryInfo[] = [];
  let entryCount = 0;

  const unzip = new Unzip();
  unzip.register(UnzipInflate);
  unzip.onfile = file => {
    entryCount++;
    if (entries.length < limit) {
      entries.push({
        name: file.name,
        compressedBytes: file.size ?? 0,
        declaredBytes: file.originalSize ?? 0
      });
    }
  };

  await pushArchive(zipPath, unzip, () => {
    if (entryCount > MAX_ENTRIES) {
      throw new AppError('ARCHIVE_TOO_MANY_ENTRIES', `The archive declares more than ${MAX_ENTRIES} entries.`, 400);
    }
  });
  return { entries, entryCount, truncated: entryCount > entries.length };
}

/**
 * Pass 2: decompress exactly the named entries, each into its own temp file.
 *
 * fflate delivers entries sequentially, so at most one shard is being written at
 * any moment; the per-shard state below is keyed by name rather than shared.
 */
async function extractNamedEntries(zipPath: string, wanted: string[], layout: ExportLayout): Promise<ExtractedShards> {
  const dir = importTempDir();
  await fs.mkdir(dir, { recursive: true });

  const targets = new Map<string, { path: string; stream: WriteStream; written: number; compressedHint: number; done: boolean }>();
  for (const name of wanted) {
    const target = path.join(dir, `shard-${randomUUID()}.json`);
    targets.set(name, { path: target, stream: createWriteStream(target), written: 0, compressedHint: 0, done: false });
  }

  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    for (const entry of targets.values()) {
      entry.stream.destroy();
      await fs.rm(entry.path, { force: true }).catch(() => { /* swept later */ });
    }
  };

  // Decompressed budget is shared across the whole shard set, not per shard, so a
  // set of individually-legal shards cannot add up past the limit.
  let totalWritten = 0;
  let failure: Error | null = null;

  const unzip = new Unzip();
  unzip.register(UnzipInflate);
  unzip.onfile = file => {
    const entry = targets.get(file.name);
    if (!entry) return; // never started -> never decompressed (this is how *.dat is skipped)
    entry.compressedHint = file.size || 0;
    file.ondata = (err, chunk, final) => {
      if (failure) return;
      if (err) { failure = err instanceof Error ? err : new Error(String(err)); return; }
      if (chunk?.length) {
        entry.written += chunk.length;
        totalWritten += chunk.length;
        if (totalWritten > env.DAMC_IMPORT_MAX_UNCOMPRESSED_BYTES) {
          failure = new AppError(
            'ARCHIVE_ENTRY_TOO_LARGE',
            `The conversation data exceeds the ${env.DAMC_IMPORT_MAX_UNCOMPRESSED_BYTES}-byte decompressed limit.`,
            413
          );
          return;
        }
        // Ratio is checked against bytes actually produced, not the size the
        // archive declares, because a bomb declares whatever it likes. The hint
        // is only trusted once it is non-zero: a ZIP written with data
        // descriptors reports 0 in the local header.
        if (entry.compressedHint > 0 && entry.written / entry.compressedHint > env.DAMC_IMPORT_MAX_COMPRESSION_RATIO) {
          failure = new AppError(
            'ARCHIVE_COMPRESSION_RATIO',
            `${file.name} decompresses at more than ${env.DAMC_IMPORT_MAX_COMPRESSION_RATIO}x, which DAMC refuses as a possible ZIP bomb.`,
            400
          );
          return;
        }
        entry.stream.write(Buffer.from(chunk));
      }
      if (final) entry.done = true;
    };
    file.start();
  };

  try {
    await pushArchive(zipPath, unzip, () => { if (failure) throw failure; });
    if (failure) throw failure;
    const missing = wanted.filter(name => !targets.get(name)!.done);
    if (missing.length) {
      throw new AppError(
        'ARCHIVE_ENTRY_UNREADABLE',
        `Could not read ${missing.join(', ')} out of the archive; the file may be corrupt.`,
        400
      );
    }
  } catch (error) {
    await cleanup();
    throw error;
  }

  // Close every write stream before the reader opens them.
  for (const entry of targets.values()) {
    await new Promise<void>((resolve, reject) => entry.stream.end((err?: Error | null) => err ? reject(err) : resolve()));
  }

  return {
    // `wanted` is already in natural shard order; preserve it.
    shards: wanted.map(name => ({ name, path: targets.get(name)!.path, bytes: targets.get(name)!.written })),
    layout,
    cleanup
  };
}

/**
 * Feed the archive to an `Unzip` instance in chunks.
 *
 * `afterChunk` runs between chunks so a limit breach stops reading the rest of a
 * multi-gigabyte file instead of scanning it to the end first.
 */
async function pushArchive(zipPath: string, unzip: Unzip, afterChunk: () => void): Promise<void> {
  const { fileChunks } = await import('./import-upload-service.js');
  try {
    for await (const chunk of fileChunks(zipPath)) {
      unzip.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength), false);
      afterChunk();
    }
    unzip.push(new Uint8Array(0), true);
  } catch (error) {
    // fflate throws on a malformed archive; translate it into something a caller
    // can show, keeping AppError instances as-is.
    if (error instanceof AppError) throw error;
    throw new AppError(
      'ARCHIVE_UNREADABLE',
      `The uploaded file is not a readable ZIP archive: ${error instanceof Error ? error.message : 'unknown error'}`,
      400
    );
  }
}
