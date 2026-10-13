/**
 * What DAMC does with each category of a Claude export — and what it refuses to do.
 *
 * A Claude export manifest lists five categories. Exactly one of them has a
 * structure DAMC has actually seen and can map to its schema:
 *
 *   conversations   IMPORTED. The ZIP carries conversations.json (or numbered
 *                   shards of it), which is the format parseClaudeConversation
 *                   already reads and which the streaming importer already
 *                   handles for a manually-uploaded Claude ZIP. Nothing new is
 *                   guessed here; the manifest path just hands the same archive
 *                   to the same reader.
 *
 *   memories        RETAINED, NOT MAPPED.
 *   projects        RETAINED, NOT MAPPED.
 *   design_chats    RETAINED, NOT MAPPED.
 *   light_metadata  RETAINED, NOT MAPPED.
 *
 * "Retained, not mapped" is a deliberate position, not an omission. The rule this
 * project works under is that a field mapping is written against an observed
 * structure, never inferred from a category name — a memory written from a guessed
 * mapping is indistinguishable from a real one afterwards, and DAMC's whole value
 * is that its memories are traceable. The structures of these four could not be
 * observed: claude.ai answers a server-side client with a Cloudflare interstitial,
 * so the archives were never obtained (see docs/CLAUDE_EXPORT_CATEGORIES.md).
 *
 * So for those categories DAMC does the two things it *can* do honestly:
 *
 *   1. KEEPS THE ARCHIVE. A Claude export_url works once. Downloading a category
 *      and then discarding it because there is no parser yet would destroy data
 *      the user cannot get back. The archive is moved into
 *      <DATA_DIR>/claude-export/<jobId>/ and stays there.
 *
 *   2. RECORDS THE REAL STRUCTURE. The archive's entry names and sizes are read
 *      (without decompressing anything) and written onto the job. That listing is
 *      the evidence a future mapping gets written against.
 *
 * Adding a category to IMPORTABLE_CATEGORIES therefore means: an archive of that
 * category was obtained, its structure was read, and a parser was written against
 * what was in it. Not before.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';
import { inspectArchiveEntries, type ArchiveEntryInfo } from './import-archive-service.js';

/** Categories with an observed structure and a parser written against it. */
export const IMPORTABLE_CATEGORIES = ['conversations'] as const;

/**
 * Why each known category is or is not imported. Surfaced to the UI so the user
 * is told what happened to every file, rather than only about the one that worked.
 */
export const CATEGORY_DISPOSITION: Record<string, { action: 'import' | 'retain'; reasonKey: string }> = {
  conversations: { action: 'import', reasonKey: 'claude.categoryConversations' },
  memories: { action: 'retain', reasonKey: 'claude.categoryRetained' },
  projects: { action: 'retain', reasonKey: 'claude.categoryRetained' },
  design_chats: { action: 'retain', reasonKey: 'claude.categoryRetained' },
  light_metadata: { action: 'retain', reasonKey: 'claude.categoryRetained' }
};

export function isImportable(category: string): boolean {
  return (IMPORTABLE_CATEGORIES as readonly string[]).includes(category);
}

/** Where retained category archives live: <DATA_DIR>/claude-export/<jobId>. */
export function retainedArchiveDir(jobId: string): string {
  return path.join(env.DATA_DIR, 'claude-export', jobId);
}

export interface RetainedArchive {
  path: string;
  bytes: number;
  entryCount: number;
  /** Entry names and header sizes — the evidence a future parser is written against. */
  entries: ArchiveEntryInfo[];
  entriesTruncated: boolean;
}

/**
 * Move a downloaded category archive out of the temp area and record its shape.
 *
 * Rename first, copy as a fallback: a temp directory configured onto another
 * volume makes `rename` fail with EXDEV, and losing a single-use download to that
 * would be the worst possible way to fail.
 */
export async function retainArchive(jobId: string, filename: string, downloadedPath: string): Promise<RetainedArchive> {
  const dir = retainedArchiveDir(jobId);
  await fs.mkdir(dir, { recursive: true });
  // The manifest's filename is data, not a path. Only its basename is used, and
  // separators are replaced rather than trimmed so two entries cannot collide.
  const safeName = path.basename(filename).replace(/[^A-Za-z0-9._-]/g, '_') || 'category.zip';
  const target = path.join(dir, safeName);

  try {
    await fs.rename(downloadedPath, target);
  } catch {
    await fs.copyFile(downloadedPath, target);
    await fs.rm(downloadedPath, { force: true }).catch(() => { /* swept later */ });
  }

  const inspection = await inspectArchiveEntries(target);
  const stat = await fs.stat(target);
  return {
    path: target,
    bytes: stat.size,
    entryCount: inspection.entryCount,
    entries: inspection.entries.slice(0, 50),
    entriesTruncated: inspection.truncated || inspection.entries.length > 50
  };
}
