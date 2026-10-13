import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../src/db/pool.js';
import { runMigrations, resolveMigrationsDir } from '../src/db/migrator.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// Both layouts: dev (scripts/migrate.ts) and built (dist/scripts/migrate.js).
const dir = await resolveMigrationsDir([
  path.resolve(here, '../migrations'),
  path.resolve(here, '../../migrations')
]);

await runMigrations(pool, dir, { onApplied: filename => console.log(`Applied ${filename}`) });
await pool.end();
