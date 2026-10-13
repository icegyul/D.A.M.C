/**
 * `npm run damc:import -- <chatgpt|claude> <path>`
 *
 * Thin CLI shell around the same runImportJob pipeline the web upload and the
 * watch folder use — nothing here parses or classifies anything itself. Kept
 * separate from scripts/damc-import.ts so the argument parsing and the report
 * formatting are plain functions a test can call without spawning a process
 * or touching the database.
 */
import path from 'node:path';
import { readImportPayload, parseImportPackage } from '../services/import-package-service.js';

export interface CliImportResult {
  jobId?: string;
  status: string;
  conversationsDetected: number;
  imported: number;
  deduplicated: number;
  memoriesCreated: number;
  superseded: number;
  decisionCount: number;
  taskCount: number;
  errors?: Array<{ conversation: string; message: string }>;
}

export interface ParsedArgs {
  provider: 'chatgpt' | 'claude';
  filePath: string;
}

const USAGE = 'Usage: npm run damc:import -- <chatgpt|claude> "<path to export.json or .zip>"';

/** Never throws on bad input — returns a usage message instead, for a clean CLI exit rather than a stack trace. */
export function parseArgs(argv: string[]): { ok: true; args: ParsedArgs } | { ok: false; message: string } {
  const [providerArg, filePath] = argv;
  if (!providerArg || !filePath) return { ok: false, message: USAGE };
  const provider = providerArg.toLowerCase();
  if (provider !== 'chatgpt' && provider !== 'claude') {
    return { ok: false, message: `Unknown provider "${providerArg}". Expected "chatgpt" or "claude".\n${USAGE}` };
  }
  return { ok: true, args: { provider, filePath } };
}

/**
 * Renders the fixed-shape report the directive asks for. Deliberately shows
 * only counts and file/provider identifiers — never message content — so a
 * conversation's actual text is never written to a terminal or a redirected
 * log file.
 */
export function formatResult(provider: string, fileName: string, result: CliImportResult): string {
  const lines = [
    'DAMC IMPORT',
    '============',
    '',
    `Provider: ${provider === 'chatgpt' ? 'ChatGPT' : 'Claude'}`,
    `File: ${fileName}`,
    '',
    'RESULT',
    '------',
    'Conversations:',
    `  Detected: ${result.conversationsDetected}`,
    `  Imported: ${result.imported}`,
    `  Duplicates: ${result.deduplicated}`,
    '',
    'Memories:',
    `  Created: ${result.memoriesCreated}`,
    `  DECISION: ${result.decisionCount}`,
    `  TASK: ${result.taskCount}`,
    `  Superseded: ${result.superseded}`,
    '',
    `Status: ${result.status.toUpperCase()}`
  ];
  if (result.errors?.length) {
    lines.push('', `Errors (${result.errors.length}):`);
    for (const e of result.errors.slice(0, 10)) lines.push(`  - ${e.conversation}: ${e.message}`);
  }
  return lines.join('\n');
}

export function formatProgress(step: string): string { return step; }

export interface ImportRunnerFn {
  (userId: string, provider: 'chatgpt' | 'claude', payload: unknown, opts?: { source?: 'cli'; fileName?: string }): Promise<CliImportResult>;
}

export interface RunCliDeps {
  readFile: (filePath: string) => Promise<Uint8Array>;
  runImportJob: ImportRunnerFn;
  userId: string;
  log?: (line: string) => void;
}

/** Returns a process exit code (0 success, 1 usage/parse/import failure) rather than calling process.exit itself, so it stays testable. */
export async function runCli(argv: string[], deps: RunCliDeps): Promise<number> {
  const log = deps.log ?? console.log;
  const parsed = parseArgs(argv);
  if (!parsed.ok) { log(parsed.message); return 1; }
  const { provider, filePath } = parsed.args;
  const fileName = path.basename(filePath);

  log('DAMC IMPORT');
  log('============');
  log('');
  log(`Provider: ${provider === 'chatgpt' ? 'ChatGPT' : 'Claude'}`);
  log(`File: ${fileName}`);
  log('');

  let bytes: Uint8Array;
  try {
    log('Reading...');
    bytes = await deps.readFile(filePath);
  } catch (error) {
    log(`\nFailed to read the file: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  let conversations;
  try {
    log('Normalizing...');
    const data = readImportPayload(bytes);
    conversations = parseImportPackage(provider, data);
  } catch (error) {
    log(`\nFailed to parse the export: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  log('Deduplicating...');
  log('Extracting memories...');
  log('');

  try {
    const result = await deps.runImportJob(deps.userId, provider, conversations, { source: 'cli', fileName });
    log(formatResult(provider, fileName, result));
    return result.status === 'failed' ? 1 : 0;
  } catch (error) {
    log(`\nImport failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
