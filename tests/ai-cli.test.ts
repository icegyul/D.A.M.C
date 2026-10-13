/**
 * AI bridge CLI + pack versioning — hermetic tests (no filesystem writes, no
 * network, no spawned processes). Only pure builders, mergers and parsers are
 * exercised; main() side effects (file writes behind --apply, `claude mcp
 * add`, HTTP reads) are verified live, not faked here.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveBaseUrl, cursorServerEntry, cursorConfigJson, claudeAddArgv,
  mergeMcpJson, renderCursorRule, mergeClaudeMd, renderClaudeSnippet,
  CLAUDE_MARK_START, CLAUDE_MARK_END, parseCliArgs, runCli, KEY_PLACEHOLDER,
  repointCursorConfig, repointClaudeConfig
} from '../src/cli/ai.js';
import { AI_PACK_VERSION } from '../src/services/connector-status-service.js';

const here = path.dirname(fileURLToPath(import.meta.url));

describe('endpoint and key resolution', () => {
  it('prefers the flag, then DAMC_PUBLIC_URL, then loopback', () => {
    expect(resolveBaseUrl('https://memory.example.com/')).toBe('https://memory.example.com');
    const prev = process.env.DAMC_PUBLIC_URL;
    process.env.DAMC_PUBLIC_URL = 'https://memory.example.com/';
    try {
      expect(resolveBaseUrl()).toBe('https://memory.example.com');
    } finally {
      if (prev === undefined) delete process.env.DAMC_PUBLIC_URL;
      else process.env.DAMC_PUBLIC_URL = prev;
    }
    expect(resolveBaseUrl()).toBe('http://127.0.0.1:8787');
  });
});

describe('config builders', () => {
  it('builds a Cursor server entry against the given endpoint', () => {
    const entry = cursorServerEntry('https://memory.example.com', 'damc_secret');
    expect(entry).toEqual({ url: 'https://memory.example.com/mcp', headers: { Authorization: 'Bearer damc_secret' } });
  });

  it('carries the placeholder — never an invented key — when no key is supplied', () => {
    expect(cursorServerEntry('https://memory.example.com', null).headers.Authorization).toContain(KEY_PLACEHOLDER);
    expect(cursorConfigJson('https://memory.example.com', null)).toContain(KEY_PLACEHOLDER);
    expect(claudeAddArgv('https://memory.example.com', null).join(' ')).toContain(KEY_PLACEHOLDER);
  });

  it('builds the exact Claude Code registration argv', () => {
    expect(claudeAddArgv('https://memory.example.com', 'damc_k')).toEqual([
      'mcp', 'add', '--transport', 'http', 'damc', 'https://memory.example.com/mcp',
      '--header', 'Authorization: Bearer damc_k'
    ]);
  });
});

describe('mergeMcpJson (never clobbers)', () => {
  const entry = cursorServerEntry('https://memory.example.com', 'damc_k');

  it('creates the document when none exists', () => {
    const r = mergeMcpJson(null, 'damc', entry);
    expect(r.ok).toBe(true);
    expect(JSON.parse(r.json!).mcpServers.damc).toEqual(entry);
    expect(r.changed).toBe(true);
  });

  it('preserves other servers and overwrites only damc', () => {
    const prev = JSON.stringify({ mcpServers: { other: { url: 'http://x' }, damc: { url: 'http://old' } } });
    const r = mergeMcpJson(prev, 'damc', entry);
    expect(r.ok).toBe(true);
    const doc = JSON.parse(r.json!);
    expect(doc.mcpServers.other).toEqual({ url: 'http://x' });
    expect(doc.mcpServers.damc).toEqual(entry);
  });

  it('reports unchanged when nothing would change', () => {
    const prev = JSON.stringify({ mcpServers: { damc: entry } }, null, 2) + '\n';
    const r = mergeMcpJson(prev, 'damc', entry);
    expect(r.ok && r.changed).toBe(false);
  });

  it('refuses invalid documents instead of destroying them', () => {
    expect(mergeMcpJson('{nope', 'damc', entry).ok).toBe(false);
    expect(mergeMcpJson('[1,2]', 'damc', entry).ok).toBe(false);
    expect(mergeMcpJson('{"mcpServers": []}', 'damc', entry).ok).toBe(false);
  });
});

describe('skill installation content', () => {
  const skill = '# shared rules';

  it('renders a Cursor rule with frontmatter and the skill body', () => {
    const rule = renderCursorRule(skill);
    expect(rule.startsWith('---\n')).toBe(true);
    expect(rule).toContain(skill);
  });

  it('creates the CLAUDE.md block when absent', () => {
    const next = mergeClaudeMd(null, renderClaudeSnippet(skill));
    expect(next).toContain(CLAUDE_MARK_START);
    expect(next).toContain(CLAUDE_MARK_END);
    expect(next).toContain(skill);
  });

  it('appends without touching existing content', () => {
    const next = mergeClaudeMd('# My project\n', renderClaudeSnippet(skill));
    expect(next.startsWith('# My project\n')).toBe(true);
    expect(next).toContain(skill);
  });

  it('replaces the marked block idempotently', () => {
    const once = mergeClaudeMd('# P\n', renderClaudeSnippet('old'));
    const twice = mergeClaudeMd(once, renderClaudeSnippet('new'));
    expect(twice).toContain('new');
    expect(twice).not.toContain('old');
    expect(mergeClaudeMd(twice, renderClaudeSnippet('new'))).toBe(twice);
  });
});

describe('CLI parsing', () => {
  it('parses flags and positionals', () => {
    const p = parseCliArgs(['ai', 'setup', 'cursor', '--apply', '--url', 'https://x']);
    expect(p.ok).toBe(true);
    expect(p.sub).toBe('setup');
    expect(p.positional).toEqual(['cursor']);
    expect(p.flags).toMatchObject({ apply: true, url: 'https://x' });
  });

  it('shows usage without running anything', async () => {
    const r = await runCli([]);
    expect(r.exit).toBe(1);
    expect(r.output).toContain('damc ai setup');
  });

  it('rejects unknown providers without side effects', async () => {
    const r = await runCli(['ai', 'setup', 'not-an-ai']);
    expect(r.exit).toBe(1);
    expect(r.output).toContain('Unknown provider');
  });

  it('renders cloud-client setup as instructions (no local files exist for them)', async () => {
    const r = await runCli(['ai', 'setup', 'chatgpt', '--url', 'https://memory.example.com']);
    expect(r.exit).toBe(0);
    expect(r.output).toContain('https://memory.example.com/mcp');
    expect(r.output).toContain('platform-limited');
  });
});

describe('repoint (URL-only, keys preserved)', () => {
  it('moves a Cursor registration without touching anything else', () => {
    const prev = JSON.stringify({ mcpServers: { other: { url: 'http://x' }, damc: { url: 'http://old/mcp', headers: { Authorization: 'Bearer damc_K' } } } });
    const r = repointCursorConfig(prev, 'https://new.example.com/mcp');
    expect(r.ok).toBe(true);
    expect(r.updated).toBe(1);
    const doc = JSON.parse(r.json!);
    expect(doc.mcpServers.damc.url).toBe('https://new.example.com/mcp');
    expect(doc.mcpServers.damc.headers).toEqual({ Authorization: 'Bearer damc_K' });
    expect(doc.mcpServers.other).toEqual({ url: 'http://x' });
  });

  it('moves every Claude Code project scope, keeping headers', () => {
    const prev = JSON.stringify({ projects: {
      'D:/a': { mcpServers: { damc: { type: 'http', url: 'http://old/mcp', headers: { Authorization: 'Bearer k1' } } } },
      'D:/b': { mcpServers: { other: {} } }
    } });
    const r = repointClaudeConfig(prev, 'https://new.example.com/mcp');
    expect(r.ok).toBe(true);
    expect(r.updated).toBe(1);
    const doc = JSON.parse(r.json!);
    expect(doc.projects['D:/a'].mcpServers.damc.url).toBe('https://new.example.com/mcp');
    expect(doc.projects['D:/a'].mcpServers.damc.headers).toEqual({ Authorization: 'Bearer k1' });
  });

  it('refuses files with no damc registration instead of inventing one', () => {
    expect(repointCursorConfig('{"mcpServers": {}}', 'https://n/mcp').ok).toBe(false);
    expect(repointClaudeConfig('{"projects": {}}', 'https://n/mcp').ok).toBe(false);
    expect(repointCursorConfig('{nope', 'https://n/mcp').ok).toBe(false);
  });
});

describe('AI pack versioning', () => {
  it('pins one PACK_VERSION shared by the API', () => {
    const file = fs.readFileSync(path.join(here, '..', 'integrations', 'PACK_VERSION'), 'utf8').trim();
    expect(file).toMatch(/^\d+\.\d+\.\d+$/);
    expect(file).toBe(AI_PACK_VERSION);
  });

  it('ships the full file set for every AI', () => {
    for (const ai of ['chatgpt', 'claude', 'cursor', 'grok', 'hermes', 'perplexity']) {
      for (const f of ['README.md', 'SETUP.md', 'CONFIG.md', 'DAMC_SKILL.md']) {
        expect(fs.existsSync(path.join(here, '..', 'integrations', ai, f)), `${ai}/${f}`).toBe(true);
      }
    }
  });
});
