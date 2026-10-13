/**
 * Reading an export file on disk as a stream of conversations.
 *
 * This is the one path every large import goes through — web upload, CLI and the
 * watch folder. It composes three bounded steps:
 *
 *   file on disk
 *     -> if ZIP: stream out the conversation shard(s) to temp files (import-archive-service)
 *     -> read each shard one array element at a time (lib/json-stream)
 *     -> convert each element with the provider's per-conversation parser
 *
 * Nothing in the chain holds the export. Peak memory is one read chunk plus one
 * conversation, so a 1.9 GB archive costs the same as a 2 MB one.
 *
 * SHARDS ARE CONCATENATED, NOT MERGED. A real OpenAI export splits conversations
 * across conversations-000.json, -001.json, -002.json. Each shard is its own JSON
 * array, so they are read in order and their elements yielded through one
 * generator — the consumer sees a single conversation stream. No shard is ever
 * combined with another into one file, one buffer, or one parse; each is opened,
 * drained and released before the next is opened.
 *
 * The small-file behaviour is deliberately identical to the old
 * parseImportPackage path: the same parsers, the same single-file preference, the
 * same BOM tolerance. Only the mechanism changed.
 */

import { streamJsonArrayElements, JsonStreamError } from '../lib/json-stream.js';
import { parseChatGPTConversation, parseClaudeConversation, detectProvider } from '../connectors/provider-export-parsers.js';
import { AppError } from '../errors/app-error.js';
import { extractConversationShards, type ExportLayout } from './import-archive-service.js';
import { fileChunks, readFileHead, looksLikeZip } from './import-upload-service.js';
import type { ConversationInput } from '../types/domain.js';

export type ImportProvider = 'chatgpt' | 'claude';

/**
 * Told to the importer as reading moves from one shard to the next, so progress
 * can be reported per shard as well as per conversation. Optional: a caller that
 * does not care passes nothing.
 */
export interface ImportStreamReporter {
  shard(index: number, name: string, total: number): void;
}

export interface ExportSourceInfo {
  /** 'zip' when the upload was an archive, 'json' when it was a bare export file. */
  container: 'zip' | 'json';
  /** How the conversations were laid out inside the archive. */
  layout: ExportLayout | 'plain';
  /** Shard entry names in read order. Empty for a bare JSON upload. */
  shardNames: string[];
  /** Number of JSON documents that will be read (1 for a single file). */
  shardCount: number;
  /** Total decompressed size of the conversation JSON actually read. */
  jsonBytes: number;
}

export interface ExportSource {
  info: ExportSourceInfo;
  /**
   * Provider guessed from the first conversation's shape, for callers that were
   * not told which provider the file belongs to (the watch folder). Reads one
   * element, not the file. Returns null rather than guessing, so a watched file
   * is never run through the wrong parser.
   */
  detectProvider: () => Promise<ImportProvider | null>;
  conversations: (provider: ImportProvider, report?: ImportStreamReporter) => AsyncGenerator<ConversationInput>;
  dispose: () => Promise<void>;
}

/** Strip a UTF-8 BOM: some provider exports include one and JSON.parse rejects it. */
async function* withoutBom(source: AsyncIterable<Buffer>): AsyncGenerator<Buffer> {
  let first = true;
  for await (const chunk of source) {
    if (first) {
      first = false;
      if (chunk.length >= 3 && chunk[0] === 0xef && chunk[1] === 0xbb && chunk[2] === 0xbf) {
        yield chunk.subarray(3);
        continue;
      }
    }
    yield chunk;
  }
}

/**
 * Open `filePath` as a conversation stream.
 *
 * Returns the source description plus generators. The caller MUST call
 * `dispose()` when finished — it removes the temp files holding extracted shards.
 * Iterating to completion does not release them, because a caller that stops
 * early still has to clean up.
 */
export async function openExportSource(filePath: string): Promise<ExportSource> {
  const head = await readFileHead(filePath, 4);
  const isZip = looksLikeZip(head);

  let documents: Array<{ path: string; name: string }> = [];
  let layout: ExportSourceInfo['layout'] = 'plain';
  let jsonBytes = 0;
  let dispose = async () => { /* a bare JSON upload owns no extra temp file */ };

  if (isZip) {
    const extracted = await extractConversationShards(filePath);
    documents = extracted.shards.map(s => ({ path: s.path, name: s.name }));
    layout = extracted.layout;
    jsonBytes = extracted.shards.reduce((total, s) => total + s.bytes, 0);
    dispose = extracted.cleanup;
  } else {
    const { stat } = await import('node:fs/promises');
    documents = [{ path: filePath, name: '' }];
    jsonBytes = (await stat(filePath)).size;
  }

  /**
   * Raw array elements across every shard, in order, provider-agnostic.
   *
   * One shard is open at a time: `streamJsonArrayElements` is driven to
   * completion for shard N before shard N+1 is opened, and it retains only its
   * own pending bytes. Nothing accumulates across the boundary.
   */
  async function* rawElements(report?: ImportStreamReporter): AsyncGenerator<unknown> {
    for (const [index, document] of documents.entries()) {
      report?.shard(index, document.name, documents.length);
      try {
        yield* streamJsonArrayElements(withoutBom(fileChunks(document.path)));
      } catch (error) {
        if (error instanceof JsonStreamError) {
          // Name the shard: with three of them, "the export is truncated" is not
          // enough to act on.
          const where = document.name ? ` in ${document.name}` : '';
          throw new AppError('EXPORT_JSON_INVALID', `${error.message}${where}`, 400);
        }
        throw error;
      }
    }
  }

  async function detectExportProvider(): Promise<ImportProvider | null> {
    for await (const element of rawElements()) {
      // detectProvider inspects the first conversation of an array; hand it a
      // one-element array so the existing heuristic is reused verbatim.
      return detectProvider([element]);
    }
    return null;
  }

  async function* conversations(provider: ImportProvider, report?: ImportStreamReporter): AsyncGenerator<ConversationInput> {
    const parseOne = provider === 'chatgpt' ? parseChatGPTConversation : parseClaudeConversation;
    // The index continues across shards so the fallback external ids the parsers
    // synthesise ("import-N") stay unique for an export that has none of its own.
    let index = 0;
    for await (const element of rawElements(report)) {
      const conversation = parseOne(element, index);
      index++;
      // A conversation with no usable message is dropped, exactly as the array
      // parsers have always done.
      if (conversation) yield conversation;
    }
  }

  return {
    info: {
      container: isZip ? 'zip' : 'json',
      layout,
      shardNames: documents.map(d => d.name).filter(Boolean),
      shardCount: documents.length,
      jsonBytes
    },
    detectProvider: detectExportProvider,
    conversations,
    dispose
  };
}

export interface ExportSummary extends ExportSourceInfo {
  conversations: number;
  messages: number;
  sampleTitles: string[];
}

/**
 * Count what an export contains without writing anything.
 *
 * Backs the preview route. It streams every shard to get a true count rather
 * than estimating, and keeps only the first few titles — so previewing a 1.9 GB
 * export costs a read, not a copy.
 */
export async function summarizeExport(filePath: string, provider: ImportProvider, sampleLimit = 5): Promise<ExportSummary> {
  const source = await openExportSource(filePath);
  try {
    let conversations = 0;
    let messages = 0;
    const sampleTitles: string[] = [];
    for await (const conversation of source.conversations(provider)) {
      conversations++;
      messages += conversation.messages.length;
      if (sampleTitles.length < sampleLimit) sampleTitles.push(conversation.title ?? conversation.externalId);
    }
    return { ...source.info, conversations, messages, sampleTitles };
  } finally {
    await source.dispose();
  }
}
