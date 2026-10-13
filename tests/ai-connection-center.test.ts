/**
 * The AI Connection Center's contract, and the two claims it must never make.
 *
 * This screen answers "which AI has actually used my memory". The danger is not
 * a rendering bug — it is the screen asserting something it cannot know. DAMC
 * runs in a container with no view of the host filesystem, so it cannot tell
 * whether an agent is installed or whether that agent's config mentions DAMC.
 * Everything here therefore pins evidence-based state, and pins the absence of
 * entries for agents whose real configuration was never read.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectionStatusFor, AI_PACK_VERSION } from '../src/services/connector-status-service.js';
import { PROVIDER_CLIENT_SLUGS, activityForProvider, type ClientActivity } from '../src/services/mcp-activity-service.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => fs.readFile(path.join(root, rel), 'utf8');

function activity(over: Partial<ClientActivity> = {}): ClientActivity {
  return {
    client: 'hermes', totalCalls: 0, failedCalls: 0,
    lastReadAt: null, lastWriteAt: null, lastContextAt: null, lastSessionAt: null, lastActivityAt: null,
    ...over
  };
}

describe('Hermes is a first-class MCP client', () => {
  it('maps the client slugs Hermes can self-report as', () => {
    // The bare slug is what normalizeClientId makes of the X-DAMC-Client header
    // the config sends; hermes-agent is the upstream package name, which a future
    // build could send as clientInfo.name instead.
    expect(PROVIDER_CLIENT_SLUGS.hermes).toEqual(['hermes', 'hermes-agent']);
  });

  it('merges activity across both slugs rather than showing two agents', () => {
    const merged = activityForProvider({
      hermes: activity({ totalCalls: 3, lastReadAt: '2026-09-13T10:00:00Z', lastActivityAt: '2026-09-13T10:00:00Z' }),
      'hermes-agent': activity({ client: 'hermes-agent', totalCalls: 2, lastWriteAt: '2026-09-13T11:00:00Z', lastActivityAt: '2026-09-13T11:00:00Z' })
    }, 'hermes')!;
    expect(merged.totalCalls).toBe(5);
    expect(merged.lastWriteAt).toBe('2026-09-13T11:00:00Z');
    expect(merged.lastActivityAt).toBe('2026-09-13T11:00:00Z');
  });

  it('ships a setup pack whose version matches the API', async () => {
    for (const file of ['README.md', 'SETUP.md', 'CONFIG.md', 'DAMC_SKILL.md']) {
      await expect(fs.stat(path.join(root, 'integrations/hermes', file)), file).resolves.toBeDefined();
    }
    expect((await read('integrations/PACK_VERSION')).trim()).toBe(AI_PACK_VERSION);
  });

  it('documents the two settings without which the integration silently does nothing', async () => {
    // Both were found by running it: with Hermes' default Tool Search the model
    // never called DAMC at all, and without the client header every call is filed
    // as "unknown" so this very screen cannot name the agent.
    const readme = await read('integrations/hermes/README.md');
    expect(readme).toContain('tool_search');
    expect(readme).toContain('X-DAMC-Client');
    // And the pack must not hand the user a config with a literal key in it.
    expect(readme).toContain('${MCP_DAMC_API_KEY}');
    expect(readme).not.toMatch(/Bearer\s+damc_[A-Za-z0-9]{10,}/);
  });

  it('offers a config that keeps the key out of the config file', async () => {
    const service = await read('src/services/connector-status-service.ts');
    const entry = service.slice(service.indexOf("provider: 'hermes'"), service.indexOf("provider: 'chatgpt'"));
    expect(entry).toContain('MCP_DAMC_API_KEY');
    expect(entry).toContain("'X-DAMC-Client': 'hermes'");
    // The .env line is where a real key goes, via the dashboard's placeholder.
    expect(entry).toContain('KEY_PLACEHOLDER');
    expect(entry).not.toMatch(/damc_[A-Za-z0-9]{16,}/);
  });
});

describe('connection state is grounded in evidence, not configuration', () => {
  it('does not call a client connected just because a key exists', () => {
    expect(connectionStatusFor('available', null, true)).toBe('CONFIGURED');
    expect(connectionStatusFor('available', null, false)).toBe('NOT_CONFIGURED');
  });

  it('promotes to ACTIVE only from a recent recorded call', () => {
    const now = new Date().toISOString();
    expect(connectionStatusFor('available', activity({ lastActivityAt: now, lastReadAt: now }), true)).toBe('ACTIVE');
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    expect(connectionStatusFor('available', activity({ lastActivityAt: old, lastWriteAt: old }), true)).toBe('WRITE_READY');
  });

  it('keeps a handshake with no tool call short of any readiness claim', () => {
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    expect(connectionStatusFor('available', activity({ lastActivityAt: old }), true)).toBe('AUTHENTICATED');
  });
});

describe('agents whose real configuration was never read are absent', () => {
  it('lists no OpenClaw or Orca integration', async () => {
    // Neither is installed on the machine this was built on, so neither product's
    // official config loader could be read. A catalog entry would have to invent
    // its setup steps, and an invented integration is worse than none: the screen
    // would be telling the user about a path nobody has walked. Add them the way
    // Hermes was added — read the config loader first, then write the entry.
    const service = await read('src/services/connector-status-service.ts');
    for (const absent of ["provider: 'openclaw'", "provider: 'orca'"]) {
      expect(service, absent).not.toContain(absent);
    }
    for (const dir of ['integrations/openclaw', 'integrations/orca']) {
      await expect(fs.stat(path.join(root, dir)), dir).rejects.toBeDefined();
    }
  });

  it('never reads an agent config off the host to decide state', async () => {
    // The container cannot see the host filesystem, so connection state is derived
    // from API keys and the audit trail and from nothing else. Naming a config path
    // in SETUP TEXT is fine and useful — telling the user where their own file lives
    // is the point. What must never appear is code that opens it: that would make
    // this screen's claims depend on a path DAMC cannot actually reach, and would
    // turn "is it connected" back into "does a file mention us".
    const service = await read('src/services/connector-status-service.ts');
    for (const io of ['node:fs', "from 'fs'", 'readFile', 'readdir', 'existsSync', 'child_process']) {
      expect(service, io).not.toContain(io);
    }
    // State comes from exactly two inputs, both database-backed.
    expect(service).toContain('connectionStatusFor(client.status, usage, keyExists)');
  });
});

describe('in-app help', () => {
  it('is registered as a page and in the navigation', async () => {
    const app = await read('web/app.js');
    expect(app).toContain("from './pages/help.js'");
    expect(app).toMatch(/const PAGES = \[[^\]]*help\]/);
    expect(app).toMatch(/id: 'help'/);
  });

  it('needs no backend, so it still works on a broken install', async () => {
    // Help is what a user opens when something is wrong. A fetch here would make
    // the help screen fail in exactly the situation it exists for.
    const help = await read('web/pages/help.js');
    expect(help).not.toMatch(/\bawait api\.|fetch\(/);
  });

  it('translates every string it renders', async () => {
    const help = await read('web/pages/help.js');
    const { DICTIONARIES } = await import('../web/i18n.js') as any;
    const keys = new Set<string>();
    for (const m of help.matchAll(/help\.([a-zA-Z0-9]+)/g)) keys.add(`help.${m[1]}`);
    for (const m of help.matchAll(/\['([a-zA-Z0-9]+)',\s*\[/g)) keys.add(`help.${m[1]}`);
    for (const m of help.matchAll(/'([a-zA-Z0-9]+)'(?=,|\])/g)) {
      if (DICTIONARIES.en[`help.${m[1]}`]) keys.add(`help.${m[1]}`);
    }
    expect(keys.size).toBeGreaterThan(20);
    for (const key of keys) {
      expect(DICTIONARIES.en[key], `en ${key}`).toBeTruthy();
      expect(DICTIONARIES.ko[key], `ko ${key}`).toBeTruthy();
    }
    expect(DICTIONARIES.en['nav.help']).toBeTruthy();
    expect(DICTIONARIES.ko['nav.help']).toBeTruthy();
  });
});

describe('user-facing documentation', () => {
  it('ships the purpose, guide and interoperability documents', async () => {
    for (const doc of ['docs/DAMC_PURPOSE.md', 'docs/DAMC_USER_GUIDE_KO.md', 'docs/DAMC_MCP_INTEROPERABILITY.md']) {
      expect((await read(doc)).length, doc).toBeGreaterThan(1500);
    }
  });

  it('states the Claude archive limitation instead of implying it works', async () => {
    // The manifest pipeline is verified; parsing a genuine Claude archive is not,
    // because one never arrived. The guide must not read as though it were.
    const guide = await read('docs/DAMC_USER_GUIDE_KO.md');
    const interop = await read('docs/DAMC_MCP_INTEROPERABILITY.md');
    expect(guide).toContain('NOT VERIFIED');
    expect(interop).toContain('NOT INSTALLED');
  });

  it('warns that a tool result count is a page length, not a total', async () => {
    const interop = await read('docs/DAMC_MCP_INTEROPERABILITY.md');
    expect(interop).toContain('count');
    expect(interop).toMatch(/페이지/);
  });

  it('tells users not to put a key in an agent config, and contains none itself', async () => {
    for (const doc of ['docs/DAMC_USER_GUIDE_KO.md', 'docs/DAMC_MCP_INTEROPERABILITY.md', 'docs/DAMC_PURPOSE.md',
                       'integrations/hermes/README.md', 'integrations/hermes/SETUP.md', 'integrations/hermes/CONFIG.md']) {
      expect(await read(doc), doc).not.toMatch(/damc_[A-Za-z0-9]{16,}/);
    }
    expect(await read('docs/DAMC_USER_GUIDE_KO.md')).toMatch(/평문/);
  });
});
