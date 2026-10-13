/**
 * Claude's export manifest.
 *
 * Claude no longer hands over one conversations.json. "Export your data" produces
 * a small manifest JSON that lists several category ZIPs, each behind its own
 * single-use download URL:
 *
 *   {
 *     "instructions": "Download each file using the export_url. Note: Each
 *                      export URL can only be used once.",
 *     "created_at": "...", "total_files": 5, "version": "1.0",
 *     "data_files": [
 *       { "category": "conversations", "part": 0, "batch_index": 0,
 *         "filename": "conversations-000.zip", "export_url": "https://claude.ai/export/…" },
 *       … projects, memories, design_chats, light_metadata
 *     ]
 *   }
 *
 * Uploaded as-is it looked like a malformed export and produced "Export JSON
 * contains no conversations array". This module recognises it instead, so the
 * user only has to hand DAMC that one file.
 *
 * Shape verified against a real manifest (5 files, version 1.0); every field name
 * below is one that manifest actually contains.
 */

import fs from 'node:fs/promises';
import { AppError } from '../errors/app-error.js';

/**
 * A real manifest is ~1.5 KB. The cap exists so this check can be run on any
 * upload without risking a read of a multi-gigabyte export into a string.
 */
export const MANIFEST_MAX_BYTES = 1024 * 1024;

/** Categories seen in a real manifest, in the order DAMC imports them. */
export const CATEGORY_PRIORITY = ['conversations', 'memories', 'projects', 'design_chats', 'light_metadata'] as const;
export type ClaudeCategory = typeof CATEGORY_PRIORITY[number];

export interface ClaudeManifestFile {
  category: string;
  filename: string;
  exportUrl: string;
  part: number | null;
  batchIndex: number | null;
}

export interface ClaudeManifest {
  version: string | null;
  createdAt: string | null;
  totalFiles: number | null;
  instructions: string | null;
  files: ClaudeManifestFile[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Cheap structural check, used to route an upload before anything is parsed.
 *
 * Deliberately narrow: a top-level `data_files` array whose first entry carries
 * the three fields that make an entry actionable. A file that merely happens to
 * have a `data_files` key is not treated as a manifest, because misrouting a real
 * conversation export would be worse than failing to recognise a manifest.
 */
export function looksLikeClaudeManifest(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const files = value.data_files;
  if (!Array.isArray(files) || files.length === 0) return false;
  return files.some(entry =>
    isRecord(entry) &&
    typeof entry.export_url === 'string' &&
    typeof entry.category === 'string' &&
    typeof entry.filename === 'string');
}

/**
 * Parse and validate a manifest.
 *
 * Throws AppError with a specific code rather than a generic parse failure: the
 * user can act on "this manifest has no downloadable entries" but not on
 * "invalid JSON". Entries missing a usable url/category/filename are rejected
 * outright — importing a partial manifest silently would consume some one-time
 * URLs and leave the user unsure what they got.
 */
export function parseClaudeManifest(value: unknown): ClaudeManifest {
  if (!isRecord(value)) {
    throw new AppError('MANIFEST_INVALID', 'The Claude manifest must be a JSON object.', 400);
  }
  const rawFiles = value.data_files;
  if (!Array.isArray(rawFiles)) {
    throw new AppError('MANIFEST_NO_DATA_FILES', 'This JSON has no "data_files" list, so it is not a Claude export manifest.', 400);
  }
  if (rawFiles.length === 0) {
    throw new AppError('MANIFEST_NO_DATA_FILES', 'The Claude manifest lists no files to download.', 400);
  }

  const files: ClaudeManifestFile[] = [];
  rawFiles.forEach((entry, index) => {
    if (!isRecord(entry)) {
      throw new AppError('MANIFEST_ENTRY_INVALID', `Entry ${index} of the manifest is not an object.`, 400);
    }
    const exportUrl = entry.export_url;
    const category = entry.category;
    const filename = entry.filename;
    if (typeof exportUrl !== 'string' || !exportUrl.trim()) {
      throw new AppError('MANIFEST_ENTRY_NO_URL', `Manifest entry ${index}${typeof category === 'string' ? ` (${category})` : ''} has no export_url.`, 400);
    }
    if (typeof category !== 'string' || !category.trim()) {
      throw new AppError('MANIFEST_ENTRY_INVALID', `Manifest entry ${index} has no category.`, 400);
    }
    if (typeof filename !== 'string' || !filename.trim()) {
      throw new AppError('MANIFEST_ENTRY_INVALID', `Manifest entry ${index} (${category}) has no filename.`, 400);
    }
    files.push({
      category: category.trim(),
      filename: filename.trim(),
      exportUrl: exportUrl.trim(),
      part: typeof entry.part === 'number' ? entry.part : null,
      batchIndex: typeof entry.batch_index === 'number' ? entry.batch_index : null
    });
  });

  return {
    version: typeof value.version === 'string' ? value.version : null,
    createdAt: typeof value.created_at === 'string' ? value.created_at : null,
    totalFiles: typeof value.total_files === 'number' ? value.total_files : null,
    instructions: typeof value.instructions === 'string' ? value.instructions : null,
    files: orderForImport(files)
  };
}

/**
 * Conversations first, then the categories that carry the most memory value.
 *
 * One-time URLs make ordering matter: if a later download fails, the user should
 * already have the part they actually came for. Unknown categories keep their
 * manifest order and go last — DAMC records them rather than guessing at them.
 */
export function orderForImport(files: ClaudeManifestFile[]): ClaudeManifestFile[] {
  const rank = (category: string) => {
    const index = (CATEGORY_PRIORITY as readonly string[]).indexOf(category);
    return index === -1 ? CATEGORY_PRIORITY.length : index;
  };
  return [...files].sort((a, b) =>
    rank(a.category) - rank(b.category) ||
    (a.part ?? 0) - (b.part ?? 0) ||
    a.filename.localeCompare(b.filename));
}

/**
 * The name an arriving download should be matched under.
 *
 * A browser does not always write the name the manifest declared. When the
 * destination folder already holds a file of that name, Chrome, Edge and Firefox
 * all write `conversations-000 (1).zip`, and a package whose only identity is its
 * filename would then match nothing at all — the download would be quarantined as
 * an unrecognised export while the user watched a package sit at "waiting".
 *
 * So exactly one transformation is applied: a trailing " (n)" before the
 * extension is dropped. Nothing else is guessed. Manifest filenames never contain
 * that shape, so the normalisation cannot make two different packages collide.
 * The result is lowercased because the filesystem this runs on is case-insensitive
 * and a package must not be missed over capitalisation.
 */
export function normalizeDownloadFilename(name: string): string {
  const base = name.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? name;
  return base.replace(/\s*\(\d+\)(?=\.[^.]*$|$)/, '').trim().toLowerCase();
}

/**
 * Is the file at `filePath` a Claude export manifest?
 *
 * Used to route an upload before it reaches the conversation reader, so dropping
 * the manifest onto the normal import box is recognised instead of failing with
 * "Export JSON contains no conversations array" — which is what it used to do, and
 * the reason this whole path exists.
 *
 * Returns null rather than throwing for anything that is not a manifest: a
 * ChatGPT export, a ZIP, unparseable JSON and a file too large to be a manifest
 * are all simply "not this", and the caller carries on with the normal path.
 */
export async function readManifestFile(filePath: string, maxBytes = MANIFEST_MAX_BYTES): Promise<ClaudeManifest | null> {
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat || !stat.isFile() || stat.size === 0 || stat.size > maxBytes) return null;
  let parsed: unknown;
  try {
    // Strip a BOM: a manifest saved by a Windows editor can carry one, and
    // JSON.parse rejects it.
    parsed = JSON.parse((await fs.readFile(filePath, 'utf8')).replace(/^﻿/, ''));
  } catch {
    return null;
  }
  if (!looksLikeClaudeManifest(parsed)) return null;
  return parseClaudeManifest(parsed);
}

/**
 * A manifest summary that costs nothing to produce.
 *
 * Backs the preview route, and deliberately reads only the manifest: previewing
 * must never touch an export_url, because using one consumes it.
 */
export function summarizeManifest(manifest: ClaudeManifest) {
  return {
    provider: 'claude' as const,
    mode: 'manifest' as const,
    version: manifest.version,
    createdAt: manifest.createdAt,
    totalFiles: manifest.totalFiles ?? manifest.files.length,
    declaredFiles: manifest.files.length,
    categories: manifest.files.map(file => ({
      category: file.category,
      filename: file.filename,
      part: file.part,
      supported: (CATEGORY_PRIORITY as readonly string[]).includes(file.category)
    })),
    // Stated so the UI can explain why previewing is safe and importing is not.
    urlsConsumed: false
  };
}
