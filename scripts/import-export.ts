/**
 * CLI entry point.
 *
 *   npm run damc:import -- chatgpt "C:\path\to\conversations.json"
 *   npm run damc:import -- claude  "C:\path\to\conversations.json"
 *
 * (kept available under its original name too: npm run import:export -- ...)
 *
 * All argument parsing, formatting and pipeline orchestration live in
 * src/cli/import-cli.ts, which takes its dependencies as plain functions —
 * that is what makes it testable without spawning this process or opening a
 * database connection. This file only supplies the real ones.
 */
import { readFile } from 'node:fs/promises';
import { runCli } from '../src/cli/import-cli.js';
import { runImportJob } from '../src/services/sync-service.js';
import { pool } from '../src/db/pool.js';

const userId = process.env.DAMC_USER_ID ?? '00000000-0000-0000-0000-000000000001';

const code = await runCli(process.argv.slice(2), {
  readFile: async filePath => new Uint8Array(await readFile(filePath)),
  runImportJob: (uid, provider, payload, opts) => runImportJob(uid, provider, payload, opts) as any,
  userId
});

await pool.end();
process.exit(code);
