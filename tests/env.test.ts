import { describe, expect, it, beforeEach, vi } from 'vitest';

async function loadEnv(overrides: Record<string, string | undefined>) {
  vi.resetModules();
  const previous = { ...process.env };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    const mod = await import('../src/config/env.js');
    return mod.env;
  } finally {
    process.env = previous;
  }
}

describe('environment booleans', () => {
  beforeEach(() => { vi.resetModules(); });

  // Regression: z.coerce.boolean() applies JS truthiness, so "false" became true and
  // DAMC_DEV_MODE=false (as set by docker-compose) left dev authentication enabled.
  it('treats DAMC_DEV_MODE="false" as false', async () => {
    const env = await loadEnv({ DAMC_DEV_MODE: 'false' });
    expect(env.DAMC_DEV_MODE).toBe(false);
  });

  it('accepts the usual falsey spellings', async () => {
    for (const value of ['false', 'FALSE', '0', 'no', 'off', '']) {
      const env = await loadEnv({ DAMC_DEV_MODE: value });
      expect(env.DAMC_DEV_MODE, `"${value}" should be false`).toBe(false);
    }
  });

  it('accepts the usual truthy spellings', async () => {
    for (const value of ['true', 'TRUE', '1', 'yes', 'on']) {
      const env = await loadEnv({ DAMC_DEV_MODE: value });
      expect(env.DAMC_DEV_MODE, `"${value}" should be true`).toBe(true);
    }
  });

  it('defaults dev mode on and GitHub backup off when unset', async () => {
    const env = await loadEnv({ DAMC_DEV_MODE: undefined, GITHUB_BACKUP_ENABLED: undefined });
    expect(env.DAMC_DEV_MODE).toBe(true);
    expect(env.GITHUB_BACKUP_ENABLED).toBe(false);
  });

  it('treats GITHUB_BACKUP_ENABLED="false" as false', async () => {
    const env = await loadEnv({ GITHUB_BACKUP_ENABLED: 'false' });
    expect(env.GITHUB_BACKUP_ENABLED).toBe(false);
  });
});
