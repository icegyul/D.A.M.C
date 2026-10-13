import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { env } from '../src/config/env.js';
import {
  ensureWatchFolders, isFileStable, scanOnce, startWatcher, stopWatcher, getWatcherStatus, _resetForTests
} from '../src/services/import-watch-service.js';

const chatgptExport = [{
  id: 'c1', current_node: 'b',
  mapping: {
    root: { id: 'root', parent: null, message: null },
    a: { id: 'a', parent: 'root', message: { id: 'a', author: { role: 'user' }, content: { parts: ['hello'] } } },
    b: { id: 'b', parent: 'a', message: { id: 'b', author: { role: 'assistant' }, content: { parts: ['world'] } } }
  }
}];
const claudeExport = [{ uuid: 'c1', chat_messages: [{ uuid: 'm1', sender: 'human', text: 'hi' }, { uuid: 'm2', sender: 'assistant', text: 'yo' }] }];

let tmpDir: string;
let originalDir: string;

beforeEach(async () => {
  originalDir = env.DAMC_IMPORT_WATCH_DIR;
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'damc-watch-'));
  env.DAMC_IMPORT_WATCH_DIR = tmpDir;
  _resetForTests();
});

afterEach(async () => {
  await stopWatcher();
  _resetForTests();
  env.DAMC_IMPORT_WATCH_DIR = originalDir;
  await fs.rm(tmpDir, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('ensureWatchFolders', () => {
  it('creates the root, processed and failed folders if they do not exist', async () => {
    const { root, processed, failed } = await ensureWatchFolders();
    expect(root).toBe(tmpDir);
    expect((await fs.stat(processed)).isDirectory()).toBe(true);
    expect((await fs.stat(failed)).isDirectory()).toBe(true);
  });

  it('is safe to call again when the folders already exist', async () => {
    await ensureWatchFolders();
    await expect(ensureWatchFolders()).resolves.toBeDefined();
  });
});

describe('getWatcherStatus hostDir', () => {
  it('falls back to the operational dir when no cosmetic host dir is configured (the non-Docker case)', async () => {
    env.DAMC_IMPORT_WATCH_HOST_DIR = '';
    const status = await getWatcherStatus();
    expect(status.hostDir).toBe(tmpDir);
  });

  it('reports the configured host path instead of the container mount point (the Docker case)', async () => {
    env.DAMC_IMPORT_WATCH_HOST_DIR = 'C:\\DAMC_IMPORT';
    const status = await getWatcherStatus();
    expect(status.hostDir).toBe('C:\\DAMC_IMPORT');
    expect(status.dir).toBe(tmpDir); // fs still operates on the real (container-side, in production) path
    env.DAMC_IMPORT_WATCH_HOST_DIR = '';
  });
});

describe('isFileStable', () => {
  it('reports a file that is not being written to as stable', async () => {
    const file = path.join(tmpDir, 'still.json');
    await fs.writeFile(file, '{}');
    expect(await isFileStable(file, 30)).toBe(true);
  });

  it('reports a file that grows mid-check as unstable', async () => {
    const file = path.join(tmpDir, 'growing.json');
    await fs.writeFile(file, '{');
    const check = isFileStable(file, 60);
    await fs.appendFile(file, '"still writing"}');
    expect(await check).toBe(false);
  });

  it('reports a missing file as unstable rather than throwing', async () => {
    expect(await isFileStable(path.join(tmpDir, 'nope.json'), 10)).toBe(false);
  });
});

describe('scanOnce', () => {
  it('imports a stable, recognized file and moves it to processed/', async () => {
    const file = path.join(tmpDir, 'chatgpt.json');
    await fs.writeFile(file, JSON.stringify(chatgptExport));
    // The watcher hands the importer a factory that opens a conversation stream,
    // not a parsed array — that is what keeps a multi-gigabyte dropped export out
    // of memory. The stream reads the watched file lazily, so it is only valid
    // while the importer runs: the watcher moves the file as soon as the importer
    // returns. Draining it inside the runner is therefore both the real contract
    // and a stronger check than the previous `expect.any(Array)`, which never
    // looked at a single conversation.
    const delivered: any[] = [];
    const runImportJob = vi.fn(async (_u: string, _p: string, open: () => AsyncIterable<any>) => {
      for await (const conversation of open()) delivered.push(conversation);
      return { status: 'completed', imported: 1, deduplicated: 0, memoriesCreated: 1, superseded: 0 };
    });

    await scanOnce('user-1', runImportJob);

    expect(runImportJob).toHaveBeenCalledWith('user-1', 'chatgpt', expect.any(Function), { source: 'watch', fileName: 'chatgpt.json' });
    expect(delivered).toHaveLength(1);
    expect(delivered[0].provider).toBe('chatgpt');
    expect(delivered[0].externalId).toBe('c1');
    expect(delivered[0].messages.map((m: any) => m.content)).toEqual(['hello', 'world']);

    await expect(fs.stat(file)).rejects.toBeDefined();
    await expect(fs.stat(path.join(tmpDir, 'processed', 'chatgpt.json'))).resolves.toBeDefined();

    const status = await getWatcherStatus();
    expect(status.lastEvent?.status).toBe('completed');
    expect(status.history.map(e => e.status)).toContain('detected');
  });

  it('detects a Claude export the same way', async () => {
    const file = path.join(tmpDir, 'claude.json');
    await fs.writeFile(file, JSON.stringify(claudeExport));
    const delivered: any[] = [];
    const runImportJob = vi.fn(async (_u: string, _p: string, open: () => AsyncIterable<any>) => {
      for await (const conversation of open()) delivered.push(conversation);
      return { status: 'completed' };
    });
    await scanOnce('user-1', runImportJob);
    expect(runImportJob).toHaveBeenCalledWith('user-1', 'claude', expect.any(Function), expect.anything());
    expect(delivered).toHaveLength(1);
    expect(delivered[0].provider).toBe('claude');
    expect(delivered[0].messages.map((m: any) => m.content)).toEqual(['hi', 'yo']);
  });

  it('moves an unparseable file to failed/ and records INVALID_JSON, without calling the pipeline', async () => {
    const file = path.join(tmpDir, 'broken.json');
    await fs.writeFile(file, 'not json at all');
    const runImportJob = vi.fn();
    await scanOnce('user-1', runImportJob);
    expect(runImportJob).not.toHaveBeenCalled();
    await expect(fs.stat(path.join(tmpDir, 'failed', 'broken.json'))).resolves.toBeDefined();
    expect((await getWatcherStatus()).lastEvent?.reason).toBe('INVALID_JSON');
  });

  it('moves a well-formed but unrecognized export to failed/ as UNSUPPORTED_PROVIDER, never guessing', async () => {
    const file = path.join(tmpDir, 'unknown.json');
    await fs.writeFile(file, JSON.stringify([{ id: 'c1', notes: 'this is not a chat export' }]));
    const runImportJob = vi.fn();
    await scanOnce('user-1', runImportJob);
    expect(runImportJob).not.toHaveBeenCalled();
    await expect(fs.stat(path.join(tmpDir, 'failed', 'unknown.json'))).resolves.toBeDefined();
    expect((await getWatcherStatus()).lastEvent?.reason).toBe('UNSUPPORTED_PROVIDER');
  });

  it('moves the file to failed/ when the pipeline itself throws, and still reports the reason', async () => {
    const file = path.join(tmpDir, 'chatgpt.json');
    await fs.writeFile(file, JSON.stringify(chatgptExport));
    const runImportJob = vi.fn().mockRejectedValue(new Error('database unreachable'));
    await scanOnce('user-1', runImportJob);
    await expect(fs.stat(path.join(tmpDir, 'failed', 'chatgpt.json'))).resolves.toBeDefined();
    expect((await getWatcherStatus()).lastEvent?.reason).toBe('IMPORT_ERROR');
  });

  it('ignores files outside the recognized .json/.zip extensions', async () => {
    await fs.writeFile(path.join(tmpDir, 'readme.txt'), 'hello');
    const runImportJob = vi.fn();
    await scanOnce('user-1', runImportJob);
    expect(runImportJob).not.toHaveBeenCalled();
  });

  it('never imports the same file twice across repeated scans (no duplicate import from re-detection)', async () => {
    const file = path.join(tmpDir, 'chatgpt.json');
    await fs.writeFile(file, JSON.stringify(chatgptExport));
    const runImportJob = vi.fn().mockResolvedValue({ status: 'completed' });

    await scanOnce('user-1', runImportJob);
    // The file already moved to processed/, so a second scan of the (now empty) root sees nothing to do.
    await scanOnce('user-1', runImportJob);

    expect(runImportJob).toHaveBeenCalledTimes(1);
  });
});

describe('startWatcher / stopWatcher', () => {
  it('starts, reports running status, and stops cleanly', async () => {
    const runImportJob = vi.fn().mockResolvedValue({ status: 'completed' });
    const status = await startWatcher('user-1', { importRunner: runImportJob, intervalMs: 50 });
    expect(status.running).toBe(true);
    expect(status.dir).toBe(tmpDir);

    const stopped = await stopWatcher();
    expect(stopped.running).toBe(false);
  });

  it('picks up a file dropped in after the watcher has started', async () => {
    const runImportJob = vi.fn().mockResolvedValue({ status: 'completed' });
    await startWatcher('user-1', { importRunner: runImportJob, intervalMs: 30 });
    await fs.writeFile(path.join(tmpDir, 'chatgpt.json'), JSON.stringify(chatgptExport));

    await vi.waitFor(async () => {
      expect(runImportJob).toHaveBeenCalled();
    }, { timeout: 3000, interval: 50 });
  });

  it('starting twice does not create a second interval', async () => {
    const runImportJob = vi.fn().mockResolvedValue({ status: 'completed' });
    await startWatcher('user-1', { importRunner: runImportJob, intervalMs: 20 });
    const again = await startWatcher('user-1', { importRunner: runImportJob, intervalMs: 20 });
    expect(again.running).toBe(true);
  });
});

/**
 * Claude export packages arriving from the user's own browser.
 *
 * This is the half of the browser-download flow that runs without a page: a ZIP
 * lands in the watch folder, gets matched to a waiting package, and is either
 * imported or kept. The package hook is injected exactly the way `importRunner`
 * already is, so none of this needs a database.
 *
 * Two of these cover gaps that existed before the feature did: no test in this file
 * had ever written a .zip, and a Claude `memories-000.zip` was being filed in
 * failed/ as INVALID_JSON.
 */
describe('Claude export packages in the watch folder', () => {
  /** A conversations archive, in the layout a real Claude export uses. */
  const conversationsZip = () => Buffer.from(zipSync({
    'conversations.json': strToU8(JSON.stringify([{
      uuid: 'p1', name: 'From a package',
      chat_messages: [{ uuid: 'm1', sender: 'human', text: 'hello' }, { uuid: 'm2', sender: 'assistant', text: 'hi' }]
    }]))
  }));

  /** A category DAMC has no parser for: valid ZIP, no conversation data in it. */
  const otherZip = () => Buffer.from(zipSync({
    'memories/index.json': strToU8('[]'),
    'memories/2026-01.json': strToU8('{"unknown":"structure"}')
  }));

  interface Call { kind: string; args: unknown[] }

  /**
   * A package hook that records what the watcher asked it to do. `matches` decides
   * which filenames belong to a session, so "no session" is a hook that matches
   * nothing — which is how every other test in this file behaves.
   */
  function stubHook(matches: Record<string, 'import' | 'retain'>) {
    const calls: Call[] = [];
    const hook = {
      async claim(_userId: string, filename: string, filePath: string) {
        calls.push({ kind: 'claim', args: [filename, filePath] });
        const route = matches[filename];
        if (!route) return null;
        return { route, package: { id: `pkg-${filename}`, category: filename.split('-')[0]!, filename, sessionJobId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' } };
      },
      async imported(claimed: any, bytes: number, importJobId: string | null, stats: Record<string, unknown>) {
        calls.push({ kind: 'imported', args: [claimed.package.filename, bytes, importJobId, stats] });
      },
      async retain(claimed: any, filePath: string) {
        calls.push({ kind: 'retain', args: [claimed.package.filename, filePath] });
        // The real implementation moves the archive out of the watch folder.
        await fs.rm(filePath, { force: true });
      },
      async failed(claimed: any, code: string, message: string) {
        calls.push({ kind: 'failed', args: [claimed.package.filename, code, message] });
      }
    };
    return { hook, calls };
  }

  it('imports a conversations package through the ordinary streaming runner', async () => {
    await fs.writeFile(path.join(tmpDir, 'conversations-000.zip'), conversationsZip());
    const { hook, calls } = stubHook({ 'conversations-000.zip': 'import' });
    // Drained INSIDE the runner, on purpose. The extracted shard is a temp file the
    // watcher deletes via source.dispose() the moment the runner resolves, so
    // reading the stream afterwards is a race that fails with ENOENT. Consuming it
    // here is also the stronger assertion: it proves the archive was readable at
    // the only moment the contract says it is valid.
    const seen: string[] = [];
    const runner = vi.fn(async (_u: string, _p: string, stream: any) => {
      for await (const conversation of stream()) seen.push(conversation.externalId);
      return { jobId: '11111111-2222-3333-4444-555555555555', imported: 1, conversations: 1, memoriesCreated: 2 };
    });

    await scanOnce('user-1', runner as never, hook);

    // The same runner contract an uploaded export uses — provider claude, streamed.
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner.mock.calls[0]![1]).toBe('claude');
    expect(runner.mock.calls[0]![3]).toEqual({ source: 'watch', fileName: 'conversations-000.zip' });
    expect(seen).toEqual(['p1']);

    const imported = calls.find(c => c.kind === 'imported')!;
    expect(imported.args[0]).toBe('conversations-000.zip');
    expect(imported.args[1]).toBeGreaterThan(0);          // size, read before the move
    expect(imported.args[2]).toBe('11111111-2222-3333-4444-555555555555');
    expect(calls.some(c => c.kind === 'failed')).toBe(false);
  });

  it('files an imported package under a session-prefixed name so two exports cannot collide', async () => {
    await fs.writeFile(path.join(tmpDir, 'conversations-000.zip'), conversationsZip());
    const { hook } = stubHook({ 'conversations-000.zip': 'import' });
    await scanOnce('user-1', vi.fn().mockResolvedValue({}), hook);

    // fs.rename replaces an existing destination, so filing two sessions' packages
    // under the bare basename would destroy the first archive.
    const processed = await fs.readdir(path.join(tmpDir, 'processed'));
    expect(processed).toEqual(['aaaaaaaa-conversations-000.zip']);
    expect(await fs.readdir(tmpDir)).not.toContain('conversations-000.zip');
  });

  /**
   * The regression this feature exists to fix. Before the package branch,
   * openExportSource threw CONVERSATIONS_JSON_MISSING for a Claude memories
   * archive and the watcher filed a single-use download in failed/ as INVALID_JSON.
   */
  it('keeps a category with no conversation data instead of calling it corrupt', async () => {
    await fs.writeFile(path.join(tmpDir, 'memories-000.zip'), otherZip());
    const { hook, calls } = stubHook({ 'memories-000.zip': 'retain' });
    const runner = vi.fn();

    await scanOnce('user-1', runner, hook);

    expect(runner).not.toHaveBeenCalled();
    expect(calls.find(c => c.kind === 'retain')!.args[0]).toBe('memories-000.zip');
    expect(calls.some(c => c.kind === 'failed')).toBe(false);
    // Not in failed/, and not left in the root either: retaining moved it away.
    expect(await fs.readdir(path.join(tmpDir, 'failed'))).toEqual([]);
    const status = await getWatcherStatus();
    expect(status.lastEvent).toMatchObject({ status: 'completed', provider: 'claude', packageCategory: 'memories' });
  });

  it('does not touch a file that belongs to no session', async () => {
    await fs.writeFile(path.join(tmpDir, 'chatgpt.json'), JSON.stringify(chatgptExport));
    const { hook, calls } = stubHook({});
    const runner = vi.fn().mockResolvedValue({});

    await scanOnce('user-1', runner, hook);

    // Claimed nothing, so the ordinary detection path ran and produced a chatgpt
    // import exactly as it did before the package branch existed.
    expect(calls.map(c => c.kind)).toEqual(['claim']);
    expect(runner.mock.calls[0]![1]).toBe('chatgpt');
  });

  it('behaves exactly as before when the package hook cannot reach its database', async () => {
    await fs.writeFile(path.join(tmpDir, 'claude.json'), JSON.stringify(claudeExport));
    const failing = {
      claim: async () => { throw new Error('no database'); },
      imported: async () => {}, retain: async () => {}, failed: async () => {}
    };
    const runner = vi.fn().mockResolvedValue({});

    await scanOnce('user-1', runner, failing);

    // A watcher that cannot look up sessions must still import ordinary files.
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner.mock.calls[0]![1]).toBe('claude');
    expect(await fs.readdir(path.join(tmpDir, 'processed'))).toEqual(['claude.json']);
  });

  it('reports a truncated package as unreadable rather than importing or keeping it', async () => {
    // A half-finished download: the ZIP signature is there, the archive is not.
    await fs.writeFile(path.join(tmpDir, 'conversations-000.zip'), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]));
    const { hook, calls } = stubHook({ 'conversations-000.zip': 'import' });
    const runner = vi.fn();

    await scanOnce('user-1', runner, hook);

    expect(runner).not.toHaveBeenCalled();
    const failed = calls.find(c => c.kind === 'failed')!;
    expect(failed.args[1]).toBe('ARCHIVE_UNREADABLE');
    expect(await fs.readdir(path.join(tmpDir, 'failed'))).toEqual(['aaaaaaaa-conversations-000.zip']);
  });

  it('records a failure when the import of a package throws', async () => {
    await fs.writeFile(path.join(tmpDir, 'conversations-000.zip'), conversationsZip());
    const { hook, calls } = stubHook({ 'conversations-000.zip': 'import' });
    const runner = vi.fn().mockRejectedValue(new Error('database is down'));

    await scanOnce('user-1', runner, hook);

    const failed = calls.find(c => c.kind === 'failed')!;
    expect(failed.args[1]).toBe('IMPORT_ERROR');
    expect(failed.args[2]).toContain('database is down');
    expect(await fs.readdir(path.join(tmpDir, 'failed'))).toEqual(['aaaaaaaa-conversations-000.zip']);
  });

  it('records a failure when keeping the archive throws, and does not lose the file', async () => {
    await fs.writeFile(path.join(tmpDir, 'memories-000.zip'), otherZip());
    const { hook, calls } = stubHook({ 'memories-000.zip': 'retain' });
    hook.retain = async () => { throw new Error('disk full'); };

    await scanOnce('user-1', vi.fn(), hook);

    expect(calls.find(c => c.kind === 'failed')!.args[1]).toBe('RETAIN_ERROR');
    // A single-use download must end up somewhere the user can still find it.
    expect(await fs.readdir(path.join(tmpDir, 'failed'))).toEqual(['aaaaaaaa-memories-000.zip']);
  });

  /**
   * Browser download names. The `.crdownload` case is why the watcher does not read
   * a file mid-write, and it is only safe because IMPORTABLE excludes it — worth
   * pinning, since nothing did.
   */
  it('files a package it has already dealt with, without importing or failing it', async () => {
    await fs.writeFile(path.join(tmpDir, 'memories-000.zip'), otherZip());
    const { hook, calls } = stubHook({});
    // What the session service reports for a file whose package is already settled.
    hook.claim = async (_u: string, filename: string) => {
      calls.push({ kind: 'claim', args: [filename] });
      return { route: 'settled' as const, package: { id: 'pkg-x', category: 'memories', filename, sessionJobId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' } };
    };
    const runner = vi.fn();

    await scanOnce('user-1', runner, hook);

    expect(runner).not.toHaveBeenCalled();
    expect(calls.map(c => c.kind)).toEqual(['claim']);
    // Not failed/ — that is the misreport the package branch exists to remove.
    expect(await fs.readdir(path.join(tmpDir, 'failed'))).toEqual([]);
    expect(await fs.readdir(path.join(tmpDir, 'processed'))).toEqual(['aaaaaaaa-memories-000.zip']);
  });

  it('ignores a browser download that is still in progress', async () => {
    await fs.writeFile(path.join(tmpDir, 'conversations-000.zip.crdownload'), conversationsZip());
    await fs.writeFile(path.join(tmpDir, 'conversations-000.zip.part'), conversationsZip());
    const { hook, calls } = stubHook({ 'conversations-000.zip': 'import' });

    await scanOnce('user-1', vi.fn(), hook);

    expect(calls).toEqual([]);
    expect(await fs.readdir(tmpDir)).toContain('conversations-000.zip.crdownload');
  });

  it('offers the collision-renamed download to the hook under its real name', async () => {
    // Chrome writes this when the folder already holds conversations-000.zip. The
    // watcher passes the name through; normalising it is the matcher's job, and this
    // pins that the watcher does not silently drop it first.
    await fs.writeFile(path.join(tmpDir, 'conversations-000 (1).zip'), conversationsZip());
    const { hook, calls } = stubHook({});

    await scanOnce('user-1', vi.fn().mockResolvedValue({}), hook);

    expect(calls[0]).toMatchObject({ kind: 'claim' });
    expect((calls[0]!.args as string[])[0]).toBe('conversations-000 (1).zip');
  });
});
