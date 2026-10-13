import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DAMC_VERSION } from '../src/version.js';
import { SERVER_VERSION } from '../src/connectors/mcp/tools.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The version used to be written out three times — package.json, the MCP
 * SERVER_VERSION every AI client reads from `initialize`, and the /health payload
 * — with nothing keeping them equal. These tests are what make src/version.ts the
 * single source it claims to be.
 */
describe('version consistency', () => {
  it('matches the version in package.json', async () => {
    const pkg = JSON.parse(await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8'));
    expect(DAMC_VERSION).toBe(pkg.version);
  });

  it('is the version MCP clients are told during initialize', () => {
    expect(SERVER_VERSION).toBe(DAMC_VERSION);
  });

  it('is not spelled out again anywhere else in src/', async () => {
    // Any new literal copy of the version in source is drift waiting to happen;
    // src/version.ts is the one file allowed to contain it.
    const offenders: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { await walk(full); continue; }
        if (!entry.name.endsWith('.ts')) continue;
        const relative = path.relative(projectRoot, full).replace(/\\/g, '/');
        if (relative === 'src/version.ts') continue;
        const source = await fs.readFile(full, 'utf8');
        for (const [index, line] of source.split('\n').entries()) {
          // Quoted occurrences only: prose in comments referring to older
          // releases ("present since DAMC 1.0.0") is history, not configuration.
          if (line.includes(`'${DAMC_VERSION}'`) || line.includes(`"${DAMC_VERSION}"`)) {
            offenders.push(`${relative}:${index + 1}`);
          }
        }
      }
    };
    await walk(path.join(projectRoot, 'src'));
    expect(offenders, `hardcoded version literals outside src/version.ts: ${offenders.join(', ')}`).toEqual([]);
  });
});
