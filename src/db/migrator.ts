/**
 * The migration runner, shared by `npm run db:migrate` (scripts/migrate.ts) and
 * the database-backed test files (tests/helpers/database.ts) so the two cannot
 * drift apart.
 *
 * Two properties it has to provide, both of which were previously missing:
 *
 * ATOMICITY. The old runner issued BEGIN, the migration SQL, the bookkeeping
 * INSERT and COMMIT through the pool's `query`, which checks out a different
 * connection per call. BEGIN opened a transaction on one connection and handed
 * it back to the pool still open; the DDL and the INSERT each ran as their own
 * autocommit; COMMIT landed on a fourth connection with nothing to commit. So a
 * migration that failed halfway left the schema partly changed, and the
 * ROLLBACK in the failure path did nothing at all.
 *
 * SAFETY UNDER CONCURRENCY. Two app containers starting together, or vitest
 * running the three database-backed files in parallel against one test database,
 * means several runners at once. The advisory lock below serialises them, and it
 * deliberately covers the creation of `_damc_migrations` as well as the
 * migrations themselves: `CREATE TABLE IF NOT EXISTS` is not atomic, and two
 * sessions that both pass its existence check fail with a duplicate key on
 * pg_type_typname_nsp_index — which is exactly what three parallel test files hit
 * on a fresh database.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type pg from 'pg';

/** Arbitrary but stable: 'DAMC' as ASCII. Every DAMC migrator waits on this key. */
export const MIGRATION_LOCK_KEY = 0x44414d43;

export interface MigrationRunOptions {
  /** Called once per migration actually applied; skipped files are silent. */
  onApplied?: (filename: string) => void;
}

/**
 * Apply every pending `.sql` file in `migrationsDir`, in filename order.
 *
 * Each migration is one transaction, so earlier successes stay committed if a
 * later file fails — the usual migration contract. The session-level lock spans
 * the whole run and is released in a `finally`.
 */
export async function runMigrations(pool: pg.Pool, migrationsDir: string, options: MigrationRunOptions = {}): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    try {
      await client.query(
        `CREATE TABLE IF NOT EXISTS _damc_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
      const files = (await fs.readdir(migrationsDir)).filter(f => f.endsWith('.sql')).sort();
      for (const filename of files) {
        const done = await client.query(`SELECT 1 FROM _damc_migrations WHERE filename=$1`, [filename]);
        if (done.rowCount) continue;
        const sql = await fs.readFile(path.join(migrationsDir, filename), 'utf8');
        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query(`INSERT INTO _damc_migrations(filename) VALUES($1)`, [filename]);
          await client.query('COMMIT');
        } catch (error) {
          // A failed ROLLBACK must not replace the error that explains the failure.
          try { await client.query('ROLLBACK'); } catch { /* connection already unusable */ }
          throw error;
        }
        options.onApplied?.(filename);
      }
    } finally {
      // Best effort: if the connection died the lock is gone with the session anyway.
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => { /* session ended */ });
    }
  } finally {
    client.release();
  }
}

/**
 * Locate the migrations directory across both layouts:
 *   dev   — scripts/migrate.ts       -> <project>/migrations
 *   built — dist/scripts/migrate.js  -> <project>/migrations
 * Without this the compiled script looked for dist/migrations, so a freshly
 * installed container could never create its schema.
 */
export async function resolveMigrationsDir(candidates: string[]): Promise<string> {
  for (const candidate of candidates) {
    try {
      const entries = await fs.readdir(candidate);
      if (entries.some(f => f.endsWith('.sql'))) return candidate;
    } catch { /* try the next layout */ }
  }
  return candidates[0]!;
}
