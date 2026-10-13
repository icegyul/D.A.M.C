import { describe, expect, it, vi } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { parseArgs, formatResult, runCli } from '../src/cli/import-cli.js';

const chatgptExport = [{
  id: 'c1', title: 'Deploy plan', current_node: 'b',
  mapping: {
    root: { id: 'root', parent: null, message: null },
    a: { id: 'a', parent: 'root', message: { id: 'a', author: { role: 'user' }, content: { parts: ['첫 메시지입니다. 이 프로젝트는 배포 방식을 도커로 결정했다.'] } } },
    b: { id: 'b', parent: 'a', message: { id: 'b', author: { role: 'assistant' }, content: { parts: ['알겠습니다, 기록해두겠습니다.'] } } }
  }
}];

describe('parseArgs', () => {
  it('accepts a known provider and a path', () => {
    const out = parseArgs(['chatgpt', 'C:\\export.json']);
    expect(out).toEqual({ ok: true, args: { provider: 'chatgpt', filePath: 'C:\\export.json' } });
  });

  it('is case-insensitive on the provider', () => {
    const out = parseArgs(['ChatGPT', 'export.json']);
    expect(out.ok && out.args.provider).toBe('chatgpt');
  });

  it('rejects a missing provider or path with usage, not a throw', () => {
    expect(parseArgs([]).ok).toBe(false);
    expect(parseArgs(['chatgpt']).ok).toBe(false);
  });

  it('rejects an unknown provider by name', () => {
    const out = parseArgs(['gemini', 'export.json']);
    expect(out.ok).toBe(false);
    expect(!out.ok && out.message).toContain('gemini');
  });
});

describe('formatResult', () => {
  it('prints only counts and identifiers, never message content', () => {
    const text = formatResult('chatgpt', 'conversations.json', {
      status: 'completed', conversationsDetected: 1, imported: 1, deduplicated: 0,
      memoriesCreated: 2, superseded: 0, decisionCount: 1, taskCount: 0
    });
    expect(text).toContain('Provider: ChatGPT');
    expect(text).toContain('File: conversations.json');
    expect(text).toContain('Detected: 1');
    expect(text).toContain('DECISION: 1');
    expect(text).toContain('Status: COMPLETED');
    // The regression this guards: a sensitive conversation body must never
    // reach a terminal or a redirected log through the CLI's own report.
    expect(text).not.toContain('첫 메시지');
    expect(text).not.toContain('배포 방식');
  });

  it('lists errors by conversation identifier only, on a partial import', () => {
    const text = formatResult('claude', 'export.json', {
      status: 'partial', conversationsDetected: 2, imported: 1, deduplicated: 0,
      memoriesCreated: 1, superseded: 0, decisionCount: 0, taskCount: 0,
      errors: [{ conversation: 'c2', message: 'missing role' }]
    });
    expect(text).toContain('Status: PARTIAL');
    expect(text).toContain('c2: missing role');
  });
});

describe('runCli', () => {
  const bytesOf = (payload: unknown) => new Uint8Array(Buffer.from(JSON.stringify(payload), 'utf8'));

  it('reads, parses and imports a ChatGPT export end to end (with a fake pipeline)', async () => {
    const log = vi.fn();
    const runImportJob = vi.fn().mockResolvedValue({
      jobId: 'job-1', status: 'completed', conversationsDetected: 1, imported: 1, deduplicated: 0,
      memoriesCreated: 1, superseded: 0, decisionCount: 1, taskCount: 0
    });
    const code = await runCli(['chatgpt', 'conversations.json'], {
      readFile: async () => bytesOf(chatgptExport),
      runImportJob,
      userId: 'u1',
      log
    });
    expect(code).toBe(0);
    expect(runImportJob).toHaveBeenCalledWith('u1', 'chatgpt', expect.any(Array), { source: 'cli', fileName: 'conversations.json' });
    const printed = log.mock.calls.map(c => c[0]).join('\n');
    expect(printed).toContain('DAMC IMPORT');
    expect(printed).toContain('Status: COMPLETED');
    // Same guarantee as formatResult, exercised through the full CLI path.
    expect(printed).not.toContain('첫 메시지');
  });

  it('unzips a ZIP export the same way the web upload does', async () => {
    const zip = zipSync({ 'chatgpt-export/conversations.json': strToU8(JSON.stringify(chatgptExport)) });
    const runImportJob = vi.fn().mockResolvedValue({ status: 'completed', conversationsDetected: 1, imported: 1, deduplicated: 0, memoriesCreated: 0, superseded: 0, decisionCount: 0, taskCount: 0 });
    const code = await runCli(['chatgpt', 'export.zip'], { readFile: async () => zip, runImportJob, userId: 'u1', log: () => {} });
    expect(code).toBe(0);
  });

  it('exits 1 with a usage message rather than throwing on bad arguments', async () => {
    const log = vi.fn();
    const code = await runCli([], { readFile: async () => new Uint8Array(), runImportJob: vi.fn(), userId: 'u1', log });
    expect(code).toBe(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Usage'));
  });

  it('exits 1 when the file cannot be read, without calling the pipeline', async () => {
    const runImportJob = vi.fn();
    const code = await runCli(['chatgpt', 'missing.json'], {
      readFile: async () => { throw new Error('ENOENT: no such file'); },
      runImportJob, userId: 'u1', log: () => {}
    });
    expect(code).toBe(1);
    expect(runImportJob).not.toHaveBeenCalled();
  });

  it('exits 1 on a file that is neither JSON nor ZIP', async () => {
    const code = await runCli(['chatgpt', 'notes.txt'], {
      readFile: async () => new Uint8Array(Buffer.from('not json at all', 'utf8')),
      runImportJob: vi.fn(), userId: 'u1', log: () => {}
    });
    expect(code).toBe(1);
  });

  it('exits 1 when the pipeline reports total failure', async () => {
    const code = await runCli(['chatgpt', 'conversations.json'], {
      readFile: async () => bytesOf(chatgptExport),
      runImportJob: vi.fn().mockRejectedValue(new Error('database unreachable')),
      userId: 'u1', log: () => {}
    });
    expect(code).toBe(1);
  });
});
