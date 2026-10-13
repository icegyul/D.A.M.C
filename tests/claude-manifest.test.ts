/**
 * Claude export manifest: recognition, and the rules that decide whether DAMC is
 * willing to fetch a URL the manifest names.
 *
 * The SSRF surface here is real and unusual: the URLs come from a file the user
 * uploaded, and the server fetches them. Most of this file is about refusing.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { env } from '../src/config/env.js';
import { AppError } from '../src/errors/app-error.js';
import {
  looksLikeClaudeManifest, parseClaudeManifest, summarizeManifest, orderForImport, readManifestFile,
  normalizeDownloadFilename, CATEGORY_PRIORITY
} from '../src/services/claude-manifest-service.js';
import { assertDownloadableUrl, downloadExportPackage, maskUrl, allowedHosts } from '../src/services/claude-download-service.js';

/** The real manifest's shape, field for field. */
const manifestJson = (overrides: Record<string, unknown> = {}) => ({
  instructions: 'Download each file using the export_url. Note: Each export URL can only be used once.',
  created_at: '2026-09-12T16:13:38Z',
  total_files: 5,
  version: '1.0',
  data_files: [
    { category: 'light_metadata', part: 0, batch_index: 0, filename: 'light_metadata-000.zip', export_url: 'https://claude.ai/export/abc/download/def' },
    { category: 'projects', part: 0, batch_index: 0, filename: 'projects-000.zip', export_url: 'https://claude.ai/export/abc/download/ghi' },
    { category: 'memories', part: 0, batch_index: 0, filename: 'memories-000.zip', export_url: 'https://claude.ai/export/abc/download/jkl' },
    { category: 'design_chats', part: 0, batch_index: 0, filename: 'design_chats-000.zip', export_url: 'https://claude.ai/export/abc/download/mno' },
    { category: 'conversations', part: 0, batch_index: 0, filename: 'conversations-000.zip', export_url: 'https://claude.ai/export/abc/download/pqr' }
  ],
  ...overrides
});

/** A normal Claude conversation export — must never be mistaken for a manifest. */
const conversationExport = [{ uuid: 'c1', chat_messages: [{ uuid: 'm1', sender: 'human', text: 'hi' }] }];

describe('A — manifest detection', () => {
  it('recognises a real Claude manifest', () => {
    expect(looksLikeClaudeManifest(manifestJson())).toBe(true);
  });

  it('does not mistake a conversation export for a manifest', () => {
    expect(looksLikeClaudeManifest(conversationExport)).toBe(false);
    expect(looksLikeClaudeManifest({ conversations: conversationExport })).toBe(false);
  });

  it('needs data_files entries that are actually actionable', () => {
    // A key called data_files is not enough: without a url/category/filename
    // there is nothing to download, and misrouting a real export would be worse
    // than failing to spot a manifest.
    expect(looksLikeClaudeManifest({ data_files: [] })).toBe(false);
    expect(looksLikeClaudeManifest({ data_files: [{ note: 'not a file' }] })).toBe(false);
    expect(looksLikeClaudeManifest({ data_files: [{ export_url: 'https://claude.ai/x' }] })).toBe(false);
    expect(looksLikeClaudeManifest({ data_files: 'nope' })).toBe(false);
  });

  it('ignores non-objects', () => {
    for (const value of [null, undefined, 42, 'text', []]) {
      expect(looksLikeClaudeManifest(value)).toBe(false);
    }
  });
});

describe('B/C/D — invalid manifests', () => {
  it('rejects a non-object', () => {
    expect(() => parseClaudeManifest([])).toThrow(/must be a JSON object/);
  });

  it('C — reports a missing data_files list specifically', () => {
    const error = (() => { try { parseClaudeManifest({ version: '1.0' }); } catch (e) { return e; } })();
    expect((error as AppError).code).toBe('MANIFEST_NO_DATA_FILES');
  });

  it('C — reports an empty data_files list', () => {
    const error = (() => { try { parseClaudeManifest({ data_files: [] }); } catch (e) { return e; } })();
    expect((error as AppError).code).toBe('MANIFEST_NO_DATA_FILES');
  });

  it('D — reports a missing export_url, naming the entry', () => {
    const broken = manifestJson();
    delete (broken.data_files[2] as any).export_url;
    const error = (() => { try { parseClaudeManifest(broken); } catch (e) { return e; } })();
    expect((error as AppError).code).toBe('MANIFEST_ENTRY_NO_URL');
    expect((error as AppError).message).toMatch(/memories/);
  });

  it('rejects an entry with no category or filename', () => {
    const noCategory = manifestJson();
    delete (noCategory.data_files[0] as any).category;
    expect(() => parseClaudeManifest(noCategory)).toThrow(/no category/);

    const noFilename = manifestJson();
    delete (noFilename.data_files[0] as any).filename;
    expect(() => parseClaudeManifest(noFilename)).toThrow(/no filename/);
  });

  it('refuses a partial manifest rather than importing what it can', () => {
    // Consuming some single-use URLs and then failing would leave the user with
    // an export they can neither finish nor repeat.
    const broken = manifestJson();
    (broken.data_files as any[]).push({ category: 'extra', filename: 'x.zip' });
    expect(() => parseClaudeManifest(broken)).toThrow(AppError);
  });
});

describe('L — a five-file manifest', () => {
  it('parses every entry with its metadata', () => {
    const manifest = parseClaudeManifest(manifestJson());
    expect(manifest.version).toBe('1.0');
    expect(manifest.totalFiles).toBe(5);
    expect(manifest.createdAt).toBe('2026-09-12T16:13:38Z');
    expect(manifest.files).toHaveLength(5);
    expect(manifest.files[0]).toMatchObject({ category: 'conversations', filename: 'conversations-000.zip', part: 0, batchIndex: 0 });
  });

  /** Conversations first: if a later single-use URL fails, the valuable part is already in. */
  it('imports conversations first and unknown categories last', () => {
    const order = parseClaudeManifest(manifestJson()).files.map(f => f.category);
    expect(order[0]).toBe('conversations');
    expect(order).toEqual([...CATEGORY_PRIORITY]);
  });

  it('E — keeps an unsupported category, ordered last, rather than dropping it', () => {
    const withUnknown = manifestJson();
    (withUnknown.data_files as any[]).push({ category: 'future_thing', part: 0, filename: 'future-000.zip', export_url: 'https://claude.ai/export/abc/download/zzz' });
    const manifest = parseClaudeManifest(withUnknown);
    expect(manifest.files).toHaveLength(6);
    expect(manifest.files.at(-1)!.category).toBe('future_thing');
  });

  it('orders multi-part categories by part number', () => {
    const files = orderForImport([
      { category: 'conversations', filename: 'c-002.zip', exportUrl: 'u', part: 2, batchIndex: 0 },
      { category: 'conversations', filename: 'c-000.zip', exportUrl: 'u', part: 0, batchIndex: 0 },
      { category: 'conversations', filename: 'c-001.zip', exportUrl: 'u', part: 1, batchIndex: 0 }
    ]);
    expect(files.map(f => f.part)).toEqual([0, 1, 2]);
  });
});

/** Requirement 10 / W: previewing must not touch a single-use URL. */
describe('W — preview does not consume an export URL', () => {
  it('summarises from the manifest alone', () => {
    const summary = summarizeManifest(parseClaudeManifest(manifestJson()));
    expect(summary).toMatchObject({ provider: 'claude', mode: 'manifest', totalFiles: 5, declaredFiles: 5, urlsConsumed: false });
    expect(summary.categories.map(c => c.category)).toEqual([...CATEGORY_PRIORITY]);
    expect(summary.categories.every(c => c.supported)).toBe(true);
  });

  it('marks an unknown category as unsupported instead of hiding it', () => {
    const withUnknown = manifestJson();
    (withUnknown.data_files as any[]).push({ category: 'future_thing', part: 0, filename: 'f.zip', export_url: 'https://claude.ai/export/a/download/b' });
    const summary = summarizeManifest(parseClaudeManifest(withUnknown));
    expect(summary.categories.find(c => c.category === 'future_thing')!.supported).toBe(false);
  });

  it('exposes no export_url at all', () => {
    const summary = summarizeManifest(parseClaudeManifest(manifestJson()));
    expect(JSON.stringify(summary)).not.toContain('download');
    expect(JSON.stringify(summary)).not.toContain('claude.ai');
  });
});

/**
 * X — routing an uploaded file.
 *
 * This is the decision that fixes the original complaint: uploading the manifest
 * used to produce "Export JSON contains no conversations array". It has to spot a
 * manifest and, just as importantly, never mistake a real export for one.
 */
describe('X — recognising a manifest on disk', () => {
  let dir: string;
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'damc-manifest-file-')); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  const write = async (name: string, content: string | Buffer) => {
    const target = path.join(dir, name);
    await fs.writeFile(target, content);
    return target;
  };

  it('reads a manifest file', async () => {
    const manifest = await readManifestFile(await write('m.json', JSON.stringify(manifestJson())));
    expect(manifest?.files).toHaveLength(5);
    expect(manifest?.version).toBe('1.0');
  });

  it('tolerates a BOM', async () => {
    // A manifest re-saved by a Windows editor carries one, and JSON.parse rejects it.
    const manifest = await readManifestFile(await write('bom.json', '﻿' + JSON.stringify(manifestJson())));
    expect(manifest?.files).toHaveLength(5);
  });

  it('returns null for a real conversation export rather than hijacking it', async () => {
    expect(await readManifestFile(await write('chatgpt.json', JSON.stringify([{ id: 'x', mapping: {} }])))).toBeNull();
    expect(await readManifestFile(await write('claude.json', JSON.stringify(conversationExport)))).toBeNull();
  });

  it('returns null for anything unparseable, empty or missing', async () => {
    expect(await readManifestFile(await write('broken.json', '{not json'))).toBeNull();
    expect(await readManifestFile(await write('empty.json', ''))).toBeNull();
    expect(await readManifestFile(path.join(dir, 'absent.json'))).toBeNull();
  });

  it('refuses to read a file too large to be a manifest', async () => {
    // The guard that lets this check run on any upload: a real manifest is ~1.5 KB,
    // so a multi-gigabyte export must never be read into a string to test it.
    const big = await write('big.json', JSON.stringify(manifestJson()));
    expect(await readManifestFile(big, 8)).toBeNull();
  });

  it('is not fooled by a ZIP', async () => {
    expect(await readManifestFile(await write('export.zip', Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])))).toBeNull();
  });
});

/**
 * Y — the name a browser actually writes.
 *
 * In the browser-download flow a package's only identity is its filename, so this
 * one function decides whether an arriving download is recognised at all. It must
 * absorb the collision rename every browser does and nothing else: a looser rule
 * would let two different packages claim the same file.
 */
describe('Y — matching a downloaded filename to a package', () => {
  it('accepts the exact name', () => {
    expect(normalizeDownloadFilename('conversations-000.zip')).toBe('conversations-000.zip');
  });

  it('absorbs the collision rename a browser adds', () => {
    // Chrome, Edge and Firefox all write this when the folder already holds the name.
    for (const name of ['conversations-000 (1).zip', 'conversations-000 (2).zip', 'conversations-000 (13).zip', 'conversations-000(1).zip']) {
      expect(normalizeDownloadFilename(name), name).toBe('conversations-000.zip');
    }
  });

  it('is case-insensitive, because the filesystem is', () => {
    expect(normalizeDownloadFilename('MEMORIES-000.ZIP')).toBe('memories-000.zip');
  });

  it('reduces any path to its basename', () => {
    expect(normalizeDownloadFilename('C:\\Users\\x\\Downloads\\projects-000.zip')).toBe('projects-000.zip');
    expect(normalizeDownloadFilename('/tmp/nested/projects-000.zip')).toBe('projects-000.zip');
    expect(normalizeDownloadFilename('../../projects-000.zip')).toBe('projects-000.zip');
  });

  it('does not collapse two genuinely different packages onto one name', () => {
    // The rule strips a counter, never a part number: conversations-000 and
    // conversations-001 are different halves of one export and must stay distinct.
    const names = ['conversations-000.zip', 'conversations-001.zip', 'design_chats-000.zip'];
    expect(new Set(names.map(normalizeDownloadFilename)).size).toBe(3);
  });

  it('leaves an in-progress download name alone', () => {
    // The watch folder ignores these by extension; normalising must not quietly
    // turn one into a finished package's name.
    expect(normalizeDownloadFilename('conversations-000.zip.crdownload')).toBe('conversations-000.zip.crdownload');
    expect(normalizeDownloadFilename('conversations-000.zip.part')).toBe('conversations-000.zip.part');
  });
});

describe('F/G — URL allowlist and SSRF', () => {
  it('accepts a real Claude export URL', async () => {
    await expect(assertDownloadableUrl('https://claude.ai/export/abc/download/def')).resolves.toBeInstanceOf(URL);
  });

  it('defaults to claude.ai only', () => {
    expect(allowedHosts()).toEqual(['claude.ai']);
  });

  it('G — refuses another domain outright', async () => {
    for (const url of ['https://evil.example/export/a/download/b', 'https://claude.ai.evil.example/x', 'https://notclaude.ai/x']) {
      const error = await assertDownloadableUrl(url).catch(e => e);
      expect((error as AppError).code, url).toBe('DOWNLOAD_URL_REJECTED');
    }
  });

  it('G — refuses loopback and private hosts', async () => {
    for (const url of [
      'https://127.0.0.1/export/a/download/b',
      'https://localhost/export/a/download/b',
      'https://10.0.0.5/x',
      'https://192.168.1.1/x',
      'https://169.254.169.254/latest/meta-data/',
      'https://[::1]/x'
    ]) {
      const error = await assertDownloadableUrl(url).catch(e => e);
      expect((error as AppError).code, url).toBe('DOWNLOAD_URL_REJECTED');
    }
  });

  it('G — refuses non-https schemes', async () => {
    for (const url of ['http://claude.ai/x', 'file:///etc/passwd', 'ftp://claude.ai/x', 'gopher://claude.ai/x']) {
      const error = await assertDownloadableUrl(url).catch(e => e);
      expect((error as AppError).code, url).toBe('DOWNLOAD_URL_REJECTED');
    }
  });

  it('G — refuses embedded credentials', async () => {
    const error = await assertDownloadableUrl('https://user:pass@claude.ai/export/a/download/b').catch(e => e);
    expect((error as AppError).code).toBe('DOWNLOAD_URL_REJECTED');
  });

  it('rejects a malformed URL', async () => {
    const error = await assertDownloadableUrl('not a url').catch(e => e);
    expect((error as AppError).code).toBe('DOWNLOAD_URL_INVALID');
  });

  it('accepts a subdomain of an allowlisted host', async () => {
    const previous = env.DAMC_CLAUDE_DOWNLOAD_HOSTS;
    env.DAMC_CLAUDE_DOWNLOAD_HOSTS = 'claude.ai,anthropic.com';
    try {
      await expect(assertDownloadableUrl('https://www.anthropic.com/a')).resolves.toBeInstanceOf(URL);
    } finally {
      env.DAMC_CLAUDE_DOWNLOAD_HOSTS = previous;
    }
  });

  it('masks every credential-bearing path segment, whatever its length', () => {
    expect(maskUrl('https://claude.ai/export/86e5d8d7-f4f4-442e/download/8c00d7f0-secret-token'))
      .toBe('https://claude.ai/export/…/download/…');
    // A short token is still a token: masking by length alone would leak it.
    expect(maskUrl('https://claude.ai/export/a1/download/b2')).toBe('https://claude.ai/export/…/download/…');
    // Even an all-letters token is masked: only known structural words survive.
    expect(maskUrl('https://claude.ai/export/abc/download/secrettoken?sig=xyz'))
      .toBe('https://claude.ai/export/…/download/…?…');
    expect(maskUrl('nonsense')).toBe('(unparseable url)');
  });
});

describe('H/I/J/K — downloading', () => {
  let tmpDir: string;
  let target: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'damc-dl-'));
    target = path.join(tmpDir, 'package.zip');
  });
  afterEach(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  /** A response whose body really is a ZIP, which the downloader now requires. */
  const ZIP_MAGIC = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
  const zipBody = (extra = 'zip-bytes-here') => {
    const payload = new Uint8Array([...ZIP_MAGIC, ...new TextEncoder().encode(extra)]);
    return new Response(new Blob([payload]).stream(), { status: 200 });
  };
  const body = (text: string) => new Response(new Blob([text]).stream(), { status: 200 });

  it('I — streams a package to disk', async () => {
    const realistic = 'https://claude.ai/export/86e5d8d7-f4f4-442e-b420-f9cb2328600f/download/8c00d7f0-secret';
    const result = await downloadExportPackage(realistic, target, {
      fetchImpl: async () => zipBody()
    });
    expect(result.bytes).toBe(18);
    expect(result.redirects).toBe(0);
    expect((await fs.readFile(target)).subarray(0, 4)).toEqual(Buffer.from(ZIP_MAGIC));
    // The recorded URL is masked, so a job row never stores a live credential.
    expect(result.finalUrl).toBe('https://claude.ai/export/…/download/…');
    expect(result.finalUrl).not.toContain('secret');
    expect(result.finalUrl).not.toContain('86e5d8d7');
  });

  it('H — follows a redirect and re-validates the destination', async () => {
    const seen: string[] = [];
    const result = await downloadExportPackage('https://claude.ai/export/a/download/b', target, {
      fetchImpl: async (input) => {
        const url = String(input);
        seen.push(url);
        if (seen.length === 1) return new Response(null, { status: 302, headers: { location: 'https://claude.ai/cdn/final.zip' } });
        return zipBody('redirected-bytes');
      }
    });
    expect(seen).toHaveLength(2);
    expect(result.redirects).toBe(1);
    expect((await fs.readFile(target)).toString('utf8')).toContain('redirected-bytes');
  });

  /** The attack a naive `redirect: 'follow'` would walk straight into. */
  it('H — refuses a redirect that leaves the allowlist', async () => {
    const error = await downloadExportPackage('https://claude.ai/export/a/download/b', target, {
      fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } })
    }).catch(e => e);
    expect((error as AppError).code).toBe('DOWNLOAD_URL_REJECTED');
    await expect(fs.stat(target)).rejects.toBeDefined();
  });

  it('H — refuses a redirect to another domain', async () => {
    const error = await downloadExportPackage('https://claude.ai/export/a/download/b', target, {
      fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/payload.zip' } })
    }).catch(e => e);
    expect((error as AppError).code).toBe('DOWNLOAD_URL_REJECTED');
  });

  it('H — stops after too many redirects', async () => {
    const error = await downloadExportPackage('https://claude.ai/export/a/download/b', target, {
      fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'https://claude.ai/loop' } })
    }).catch(e => e);
    expect((error as AppError).message).toMatch(/Too many redirects/);
  });

  it('K — reports a spent single-use URL as its own condition', async () => {
    for (const status of [403, 404, 410]) {
      const error = await downloadExportPackage('https://claude.ai/export/a/download/b', target, {
        fetchImpl: async () => new Response(null, { status })
      }).catch(e => e);
      expect((error as AppError).code, String(status)).toBe('DOWNLOAD_URL_CONSUMED');
      expect((error as AppError).message).toMatch(/already been used or has expired/);
      expect((error as AppError).message).toMatch(/new export/);
    }
  });

  /**
   * What claude.ai actually does to a server-side client, verified live: a
   * Cloudflare interstitial, sometimes 403 and sometimes 200 with HTML. Reporting
   * either as "your link was already used" would send the user off to create
   * export after export, none of which could ever work.
   */
  it('distinguishes a bot-protection challenge from a spent link', async () => {
    const challenge403 = await downloadExportPackage('https://claude.ai/export/a/download/b', target, {
      fetchImpl: async () => new Response('<html>Just a moment...</html>', {
        status: 403, headers: { 'content-type': 'text/html; charset=UTF-8', 'cf-mitigated': 'challenge' }
      })
    }).catch(e => e);
    expect((challenge403 as AppError).code).toBe('DOWNLOAD_BLOCKED_BY_CHALLENGE');
    expect((challenge403 as AppError).message).toMatch(/browser/);
  });

  it('rejects a challenge page served with HTTP 200 instead of storing it as a ZIP', async () => {
    // The dangerous variant: status says success, so only the payload reveals it.
    const error = await downloadExportPackage('https://claude.ai/export/a/download/b', target, {
      fetchImpl: async () => new Response('<!DOCTYPE html><html><title>Just a moment...</title></html>', {
        status: 200, headers: { 'content-type': 'text/html' }
      })
    }).catch(e => e);
    expect((error as AppError).code).toBe('DOWNLOAD_BLOCKED_BY_CHALLENGE');
    await expect(fs.stat(target)).rejects.toBeDefined();
  });

  it('rejects a 200 response that is simply not an archive', async () => {
    const error = await downloadExportPackage('https://claude.ai/export/a/download/b', target, {
      fetchImpl: async () => new Response('plain text, not a zip', { status: 200, headers: { 'content-type': 'text/plain' } })
    }).catch(e => e);
    expect((error as AppError).code).toBe('DOWNLOAD_NOT_AN_ARCHIVE');
    await expect(fs.stat(target)).rejects.toBeDefined();
  });

  it('J — reports other HTTP failures as download failures', async () => {
    const error = await downloadExportPackage('https://claude.ai/export/a/download/b', target, {
      fetchImpl: async () => new Response(null, { status: 500 })
    }).catch(e => e);
    expect((error as AppError).code).toBe('DOWNLOAD_FAILED');
  });

  it('J — reports a network error without leaking the URL', async () => {
    const error = await downloadExportPackage('https://claude.ai/export/abcdefghijkl/download/secrettoken', target, {
      fetchImpl: async () => { throw new Error('ECONNRESET'); }
    }).catch(e => e);
    expect((error as AppError).code).toBe('DOWNLOAD_FAILED');
    expect((error as AppError).message).not.toContain('secrettoken');
  });

  it('J — refuses an empty response rather than importing nothing', async () => {
    const error = await downloadExportPackage('https://claude.ai/export/a/download/b', target, {
      fetchImpl: async () => body('')
    }).catch(e => e);
    expect((error as AppError).code).toBe('DOWNLOAD_FAILED');
    await expect(fs.stat(target)).rejects.toBeDefined();
  });

  it('U — enforces the size cap and leaves no partial file', async () => {
    const error = await downloadExportPackage('https://claude.ai/export/a/download/b', target, {
      maxBytes: 8,
      fetchImpl: async () => zipBody('far more than eight bytes')
    }).catch(e => e);
    expect((error as AppError).code).toBe('DOWNLOAD_TOO_LARGE');
    expect((error as AppError).statusCode).toBe(413);
    await expect(fs.stat(target)).rejects.toBeDefined();
  });

  it('never fetches a rejected URL at all', async () => {
    let called = false;
    await downloadExportPackage('https://evil.example/x', target, {
      fetchImpl: async () => { called = true; return zipBody(); }
    }).catch(() => null);
    expect(called).toBe(false);
  });
});
