import pg from 'pg';
import { env } from '../config/env.js';

const { Pool } = pg;
export const pool = new Pool({ connectionString: env.DATABASE_URL });

/**
 * Background failures on *idle* pooled connections — a PostgreSQL restart, a dropped
 * network link, an administrator terminating the backend — are emitted on the pool
 * itself rather than on any pending query. An EventEmitter with no 'error' listener
 * rethrows, so without this handler a routine `docker compose restart db` terminated
 * the whole Node process.
 *
 * pg has already discarded the broken client by the time this runs, so the next query
 * transparently opens a fresh connection once PostgreSQL is reachable again.
 *
 * This deliberately does not hide failures: a query issued while the database is
 * unreachable still rejects and the request still fails. DAMC reports the outage
 * rather than serving mocked or stale data.
 */
pool.on('error', (error: Error) => {
  // The connection string carries credentials and is never logged.
  process.stderr.write(`${JSON.stringify({
    level: 'error',
    source: 'db.pool',
    msg: 'idle postgres client failed; client discarded, pool remains usable',
    error: error.message,
    code: (error as NodeJS.ErrnoException).code ?? null,
    time: new Date().toISOString()
  })}\n`);
});

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params);
}

/**
 * The one capability a write path needs from its database handle. Both the pool
 * and a single checked-out client satisfy it, so a repository function can run
 * either on its own connection or inside a caller's transaction without the SQL
 * being written twice.
 */
export interface Queryable {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params?: unknown[]): Promise<pg.QueryResult<T>>;
}

/**
 * Run `fn` as one transaction on a single pooled connection.
 *
 * Every call to the exported `query` above checks out its own connection, so a
 * multi-statement write executed through it is a sequence of independent
 * autocommits. For memory supersession that is not an implementation detail but
 * a correctness bug: inserting the replacement memory, marking the previous one
 * superseded, writing its version row and recording the SUPERSEDES relation are
 * four statements, and a failure after any of them leaves the hub in a state it
 * has no way to describe — two contradictory active decisions, or a superseded
 * memory whose replacement is unreachable because the relation never landed.
 *
 * It also makes row locks real. `SELECT … FOR UPDATE` outside an explicit
 * transaction is wrapped in a single-statement transaction that commits
 * immediately, releasing the lock before the caller can act on the row; two
 * concurrent writers could both read the same active decision and both
 * supersede it. Inside this helper the lock is held until COMMIT.
 */
export async function withTransaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    // A ROLLBACK that itself fails (the connection is already gone) must not
    // replace the error that actually explains the failure.
    try { await client.query('ROLLBACK'); } catch { /* connection is unusable; releasing it below discards it */ }
    throw error;
  } finally {
    client.release();
  }
}
