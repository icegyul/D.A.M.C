/**
 * Receiving a large import upload.
 *
 * The uploaded file is streamed straight to a temp file and never held in
 * memory. The route then reads that file back incrementally, so the peak cost of
 * importing a 1.9 GB export is one temp file on disk plus one conversation in
 * memory — not 1.9 GB of Buffer.
 *
 * WHY NOT toBuffer(): @fastify/multipart's `toBuffer()` concatenates the whole
 * upload. At 1.9 GB that is a multi-gigabyte allocation before any parsing
 * begins, and it is what produced the original failure.
 *
 * THE TRAP THIS MODULE EXISTS TO AVOID: simply replacing `toBuffer()` with a
 * pipeline into a write stream is *silently wrong*. When the configured
 * `fileSize` is exceeded, @fastify/busboy pushes the partial chunk, sets
 * `truncated = true`, and then still calls `push(null)` — the stream ends
 * cleanly. @fastify/multipart's `'limit'` listener only stores the error in a
 * variable nothing drains. So the pipeline RESOLVES, a half-written file sits on
 * disk, and the request would answer 200 for an upload that was cut off. Only
 * `part.file.truncated` reveals it (`part.truncated` does not exist), and this
 * module checks it on every path.
 */

import fs from 'node:fs/promises';
import { createWriteStream, createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { MultipartFile } from '@fastify/multipart';
import { env } from '../config/env.js';
import { AppError } from '../errors/app-error.js';

/** Where temp uploads live. Created on demand. */
export function importTempDir(): string {
  return env.DAMC_IMPORT_TEMP_DIR || path.join(env.DATA_DIR, 'tmp');
}

export interface StoredUpload {
  /** Absolute path of the temp file holding the upload. */
  path: string;
  filename: string;
  /** Bytes actually written to disk. */
  bytes: number;
  /** Remove the temp file. Safe to call more than once. */
  cleanup: () => Promise<void>;
}

/**
 * Drain a multipart file part to a temp file.
 *
 * Throws AppError 413 when the upload exceeds the configured maximum, and
 * deletes the partial file first — a rejected upload never leaves bytes behind.
 */
export async function storeUploadToTempFile(file: MultipartFile): Promise<StoredUpload> {
  const dir = importTempDir();
  await fs.mkdir(dir, { recursive: true });

  // The name is generated, never derived from the client's filename: a
  // caller-supplied name is the classic path-traversal vector, and nothing here
  // needs it on disk. The original is kept only as a label for the job history.
  const target = path.join(dir, `upload-${randomUUID()}.bin`);
  const filename = file.filename || 'upload';

  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await fs.rm(target, { force: true }).catch(() => { /* best effort; the temp sweep will catch it */ });
  };

  try {
    await pipeline(file.file, createWriteStream(target));
  } catch (error) {
    await cleanup();
    throw error;
  }

  // The truncation check MUST come after the pipeline resolves, because a
  // truncated upload resolves exactly like a complete one. See the module note.
  if (file.file.truncated) {
    await cleanup();
    throw new AppError(
      'FILE_TOO_LARGE',
      `The upload exceeds the maximum import file size this server accepts (${env.DAMC_IMPORT_MAX_FILE_SIZE_BYTES} bytes).`,
      413,
      { maxBytes: env.DAMC_IMPORT_MAX_FILE_SIZE_BYTES, bytesRead: file.file.bytesRead }
    );
  }

  const stat = await fs.stat(target).catch(() => null);
  if (!stat || stat.size === 0) {
    await cleanup();
    throw new AppError('EMPTY_UPLOAD', 'The uploaded file is empty.', 400);
  }

  return { path: target, filename, bytes: stat.size, cleanup };
}

/** First bytes of a file, for content sniffing without reading the whole thing. */
export async function readFileHead(filePath: string, length = 4): Promise<Buffer> {
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** ZIP local-file / central-directory / spanning signatures. */
export function looksLikeZip(head: Buffer): boolean {
  return head.length > 3 && head[0] === 0x50 && head[1] === 0x4b
    && (head[2] === 0x03 || head[2] === 0x05 || head[2] === 0x07);
}

/**
 * Byte chunks of a file, for the JSON reader and the ZIP reader.
 * 256 KiB balances syscall count against the pending-buffer size the JSON
 * scanner holds while it completes an element.
 */
export function fileChunks(filePath: string, highWaterMark = 256 * 1024): AsyncIterable<Buffer> {
  return createReadStream(filePath, { highWaterMark });
}

/**
 * Delete temp uploads left behind by a crash.
 *
 * Called at boot. A normal import cleans up in its own `finally`; this only
 * catches files orphaned by a process that died mid-upload, which would
 * otherwise accumulate gigabytes silently.
 */
export async function sweepImportTempDir(olderThanMs = 6 * 60 * 60 * 1000): Promise<number> {
  const dir = importTempDir();
  let removed = 0;
  const entries = await fs.readdir(dir).catch(() => null);
  if (!entries) return 0;
  const cutoff = Date.now() - olderThanMs;
  for (const entry of entries) {
    if (!entry.startsWith('upload-')) continue;
    const full = path.join(dir, entry);
    const stat = await fs.stat(full).catch(() => null);
    if (!stat?.isFile() || stat.mtimeMs > cutoff) continue;
    await fs.rm(full, { force: true }).then(() => { removed++; }).catch(() => { /* leave it for next time */ });
  }
  return removed;
}
