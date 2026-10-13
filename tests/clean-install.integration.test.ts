/**
 * What a brand-new install actually contains.
 *
 * Every other database-backed file scopes its counts to a test user, because they
 * share one test database and run in parallel. That is correct for them and useless
 * here: the claim under test is that a *freshly migrated* database holds nothing at
 * all, which can only be asserted unscoped, on a database nothing else has touched.
 *
 * So this file creates its own database, migrates it with the same runner the
 * installer uses, counts every user-data table without a WHERE clause, and drops it.
 * It is the only test in the suite that can fail if DAMC ever starts seeding itself.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../src/db/migrator.js';
import { requireDatabase, TEST_DATABASE_URL } from './helpers/database.js';

const dbAvailable = await requireDatabase();

/** Its own database, so "no rows anywhere" means exactly that. */
const CLEAN_DB = 'damc_clean_install_test';
const adminUrl = TEST_DATABASE_URL.replace(/\/[^/]*$/, '/postgres');
const cleanUrl = TEST_DATABASE_URL.replace(/\/[^/]*$/, `/${CLEAN_DB}`);
const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');

/**
 * Every table that holds something a user would recognise as their own. All of them
 * must be empty on a fresh install; `users` is deliberately absent — the local owner
 * row is provisioned at boot because every other table's foreign key needs it, and it
 * carries no content.
 */
const USER_DATA_TABLES = [
  'projects', 'conversations', 'messages', 'memories', 'memory_versions',
  'relations', 'sync_jobs', 'api_keys', 'current_states',
  'claude_export_downloads', 'claude_export_packages'
];

describe.runIf(dbAvailable)('a freshly migrated database (isolated damc_clean_install_test)', () => {
  let admin: Pool;
  let clean: Pool;

  beforeAll(async () => {
    admin = new Pool({ connectionString: adminUrl });
    // Drop first: a previous run that died before afterAll must not make this one
    // assert against a dirty database and pass for the wrong reason.
    await admin.query(`DROP DATABASE IF EXISTS ${CLEAN_DB}`);
    await admin.query(`CREATE DATABASE ${CLEAN_DB}`);
    clean = new Pool({ connectionString: cleanUrl });
    await runMigrations(clean, migrationsDir);
  }, 120000);

  afterAll(async () => {
    await clean?.end().catch(() => { /* already broken */ });
    await admin?.query(`DROP DATABASE IF EXISTS ${CLEAN_DB}`).catch(() => { /* leave it for the next run to drop */ });
    await admin?.end().catch(() => { /* already broken */ });
  });

  it('applies every migration', async () => {
    const applied = await clean.query<{ filename: string }>(`SELECT filename FROM _damc_migrations ORDER BY filename`);
    const names = applied.rows.map(r => r.filename);
    // Not a fixed count: the point is that the whole directory ran, so adding a
    // migration cannot leave this test asserting an old schema.
    expect(names.length).toBeGreaterThanOrEqual(7);
    expect(names[0]).toMatch(/^001_/);
    expect(names).toContain('007_claude_export_packages.sql');
  });

  it('creates the tables the product needs', async () => {
    const tables = await clean.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public'`);
    const names = tables.rows.map(r => r.table_name);
    for (const table of [...USER_DATA_TABLES, 'users']) {
      expect(names, table).toContain(table);
    }
  });

  it('holds no rows in any user-data table', async () => {
    // The acceptance condition, unscoped. A seeder, a fixture, or a migration that
    // inserted anything would fail here and nowhere else in the suite.
    for (const table of USER_DATA_TABLES) {
      const result = await clean.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${table}`);
      expect(Number(result.rows[0]!.count), `${table} must be empty on a fresh install`).toBe(0);
    }
  });

  it('has no user rows until the server provisions the local owner', async () => {
    // Migrations create schema only. The one row DAMC adds at boot is the local
    // owner, added by the server rather than by a migration — so a database that has
    // been migrated but never run has nobody in it.
    const users = await clean.query<{ count: string }>(`SELECT count(*)::text AS count FROM users`);
    expect(Number(users.rows[0]!.count)).toBe(0);
  });

  it('installs pg_trgm and the Korean search indexes', async () => {
    const ext = await clean.query<{ extname: string }>(`SELECT extname FROM pg_extension WHERE extname='pg_trgm'`);
    expect(ext.rows).toHaveLength(1);
    const indexes = await clean.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexdef ILIKE '%gin_trgm_ops%'`);
    // Korean retrieval depends on these: to_tsvector('simple') cannot split an
    // agglutinative token from its particle, so trigram is the whole mechanism.
    expect(indexes.rows.length).toBeGreaterThanOrEqual(3);
  });

  it('is idempotent — migrating twice changes nothing', async () => {
    const before = await clean.query<{ filename: string }>(`SELECT filename FROM _damc_migrations ORDER BY filename`);
    await runMigrations(clean, migrationsDir);
    const after = await clean.query<{ filename: string }>(`SELECT filename FROM _damc_migrations ORDER BY filename`);
    expect(after.rows.map(r => r.filename)).toEqual(before.rows.map(r => r.filename));
    // And still empty: a re-run must not insert anything either.
    for (const table of USER_DATA_TABLES) {
      const result = await clean.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${table}`);
      expect(Number(result.rows[0]!.count), table).toBe(0);
    }
  });
});
