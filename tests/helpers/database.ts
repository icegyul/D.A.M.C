/**
 * Shared setup for the database-backed test files.
 *
 * Two things live here that used to be copied into each of them.
 *
 * 1. THE SKIP POLICY (see requireDatabase below). These files self-skip when
 *    Postgres is unreachable so that a contributor without a database can still
 *    run the unit suite. The cost is that the same `npm test` reports success
 *    either way: with a database it runs 714 tests; without one, 47 of them skip and
 *    still exits 0. Nothing in the output says the difference, so a CI job or a
 *    release check that only looks at the exit code can sign off on a build whose
 *    entire persistence layer — supersession, transactions, provenance — was
 *    never executed. DAMC_REQUIRE_DB=1 turns that silence into a hard failure.
 *
 * 2. MIGRATION APPLICATION. All three files target the same damc_test database
 *    and vitest runs them in parallel, so they race to create the schema. The
 *    lock below serialises them.
 */

import { Pool } from 'pg';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../../src/db/migrator.js';

export const TEST_DATABASE_URL = process.env.DAMC_TEST_DATABASE_URL ?? 'postgresql://damc:damc@127.0.0.1:5432/damc_test';

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');

/**
 * Is the test database reachable, and is being unreachable acceptable?
 *
 * Returns true/false for `describe.runIf`. When DAMC_REQUIRE_DB is set to a
 * truthy value it throws instead of returning false, which fails the file at
 * collection time — that is the point: a build pipeline that must not ship
 * untested persistence sets DAMC_REQUIRE_DB=1 and can no longer be given a
 * green run by a missing database.
 */
export async function requireDatabase(): Promise<boolean> {
  let failure: unknown;
  const probe = new Pool({ connectionString: TEST_DATABASE_URL, connectionTimeoutMillis: 2000 });
  try {
    await probe.query('SELECT 1');
    return true;
  } catch (error) {
    failure = error;
  } finally {
    await probe.end().catch(() => { /* probe pool may already be broken */ });
  }

  if (isDatabaseRequired()) {
    throw new Error(
      `DAMC_REQUIRE_DB is set, so the integration suite must run, but ${redactUrl(TEST_DATABASE_URL)} is unreachable: ` +
      `${failure instanceof Error ? failure.message : String(failure)}. ` +
      `Start Postgres and create the database (CREATE DATABASE damc_test OWNER damc), or unset DAMC_REQUIRE_DB to allow skipping.`
    );
  }
  return false;
}

export function isDatabaseRequired(): boolean {
  const raw = (process.env.DAMC_REQUIRE_DB ?? '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

/** Never put a password in a test failure message. */
function redactUrl(url: string): string {
  return url.replace(/\/\/[^@/]*@/, '//***@');
}

/**
 * Apply every migration to the test database, using the same runner
 * `npm run db:migrate` uses (src/db/migrator.ts) — including its advisory lock,
 * which is what lets the three database-backed files run in parallel against one
 * test database without racing to create the schema.
 *
 * Uses its own short-lived pool rather than src/db/pool.js: the callers override
 * process.env.DATABASE_URL before importing src, and this keeps schema setup
 * independent of that ordering.
 */
export async function applyMigrations(): Promise<void> {
  const pool = new Pool({ connectionString: TEST_DATABASE_URL });
  try {
    await runMigrations(pool, migrationsDir);
  } finally {
    await pool.end();
  }
}
