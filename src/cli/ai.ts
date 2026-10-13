/**
 * `damc ai ...` — the bridge between "docs" and "actually connected".
 *
 * A thin CLI shell over things DAMC already does: it generates the exact MCP
 * configs AI clients need, merges them into the client's own files (backing
 * up first, never blindly overwriting), prints the shared skill, and reads a
 * project's live context back through the same REST the dashboard uses.
 *
 * Same contract as src/cli/import-cli.ts: argument parsing, merging and
 * rendering are pure exported functions a test can call without touching the
 * filesystem, the network, or a database. Only main() performs side effects,
 * and only with --apply (setup/skill) — without it every command is dry-run.
 *
 *   damc ai setup claude [--url URL] [--key KEY] [--apply]
 *   damc ai setup cursor [--url URL] [--key KEY] [--project DIR] [--apply]
 *   damc ai setup chatgpt|grok|perplexity [--url URL]
 *   damc ai skill cursor|claude [--project DIR] [--apply]
 *   damc ai context <project> [--url URL] [--key KEY]
 *   damc ai status [--url URL] [--key KEY]
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '..', '..');

export const LOOPBACK = 'http://127.0.0.1:8787';
export const KEY_PLACEHOLDER = '<YOUR_DAMC_API_KEY>';

/** Endpoint precedence: explicit flag, operator's public URL, loopback. */
export function resolveBaseUrl(flagUrl?: string): string {
  const raw = (flagUrl ?? process.env.DAMC_PUBLIC_URL ?? LOOPBACK).trim();
  return raw.replace(/\/+$/, '');
}

/** Key precedence: explicit flag, environment. Null means "no key supplied". */
export function resolveApiKey(flagKey?: string): string | null {
  const raw = (flagKey ?? process.env.DAMC_API_KEY ?? '').trim();
  return raw || null;
}

export function authHeaders(apiKey: string | null): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

// ---------------------------------------------------------------------------
// Config builders (pure)
// ---------------------------------------------------------------------------

export interface McpServerEntry {
  url: string;
  headers: Record<string, string>;
}

export function cursorServerEntry(baseUrl: string, apiKey: string | null): McpServerEntry {
  return { url: `${baseUrl}/mcp`, headers: { Authorization: `Bearer ${apiKey ?? KEY_PLACEHOLDER}` } };
}

export function cursorConfigJson(baseUrl: string, apiKey: string | null): string {
  return JSON.stringify({ mcpServers: { damc: cursorServerEntry(baseUrl, apiKey) } }, null, 2) + '\n';
}

/** Claude Code registration command (argv form, no shell quoting hazards). */
export function claudeAddArgv(baseUrl: string, apiKey: string | null): string[] {
  return ['mcp', 'add', '--transport', 'http', 'damc', `${baseUrl}/mcp`,
    '--header', `Authorization: Bearer ${apiKey ?? KEY_PLACEHOLDER}`];
}

export interface MergeResult {
  ok: boolean;
  json?: string;
  changed?: boolean;
  error?: string;
}

/**
 * Merge one MCP server into an mcp.json document. Existing servers are
 * preserved; only the `damc` entry is set. Never throws on bad input.
 */
export function mergeMcpJson(existing: string | null, serverName: string, entry: McpServerEntry): MergeResult {
  let doc: Record<string, unknown> = {};
  if (existing !== null && existing.trim() !== '') {
    try {
      // Editors (and PowerShell redirection) love a BOM; JSON does not.
      doc = JSON.parse(existing.replace(/^﻿/, '')) as Record<string, unknown>;
    } catch {
      return { ok: false, error: 'Existing mcp.json is not valid JSON — left untouched. Fix or move it aside, then re-run.' };
    }
    if (typeof doc !== 'object' || Array.isArray(doc)) {
      return { ok: false, error: 'Existing mcp.json is not an object — left untouched.' };
    }
  }
  const servers = doc.mcpServers;
  if (servers !== undefined && (typeof servers !== 'object' || servers === null || Array.isArray(servers))) {
    return { ok: false, error: 'Existing mcp.json has a non-object "mcpServers" — left untouched.' };
  }
  const next = { ...(doc as object), mcpServers: { ...((servers ?? {}) as object), [serverName]: entry } };
  const json = JSON.stringify(next, null, 2) + '\n';
  return { ok: true, json, changed: json !== existing };
}

// ---------------------------------------------------------------------------
// Repoint (pure): move existing registrations to a new endpoint URL.
// Keys and every other setting stay exactly as they are — only the URL
// changes. Used when an ephemeral tunnel URL rotates.
// ---------------------------------------------------------------------------

function parseJsonDoc(existing: string): { ok: true; doc: Record<string, unknown> } | { ok: false; error: string } {
  try {
    const doc = JSON.parse(existing.replace(/^﻿/, '')) as unknown;
    if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
      return { ok: false, error: 'Not a JSON object — left untouched.' };
    }
    return { ok: true, doc: doc as Record<string, unknown> };
  } catch {
    return { ok: false, error: 'Not valid JSON — left untouched.' };
  }
}

export interface RepointResult {
  ok: boolean;
  json?: string;
  updated?: number;
  error?: string;
}

/** Rewrite the damc server URL inside a Cursor mcp.json document. */
export function repointCursorConfig(existing: string, newUrl: string): RepointResult {
  const parsed = parseJsonDoc(existing);
  if (!parsed.ok) return parsed;
  const servers = parsed.doc.mcpServers;
  if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) {
    return { ok: false, error: 'No mcpServers object — left untouched.' };
  }
  const entry = (servers as Record<string, unknown>).damc;
  if (typeof entry !== 'object' || entry === null) {
    return { ok: false, error: 'No damc server registered — run `damc ai setup cursor --apply` first.' };
  }
  (entry as Record<string, unknown>).url = newUrl;
  return { ok: true, json: JSON.stringify(parsed.doc, null, 2) + '\n', updated: 1 };
}

/** Rewrite damc server URLs inside a Claude Code .claude.json (all project scopes). */
export function repointClaudeConfig(existing: string, newUrl: string): RepointResult {
  const parsed = parseJsonDoc(existing);
  if (!parsed.ok) return parsed;
  const projects = parsed.doc.projects;
  if (typeof projects !== 'object' || projects === null || Array.isArray(projects)) {
    return { ok: false, error: 'No Claude Code project scopes found — run `damc ai setup claude --apply` first.' };
  }
  let updated = 0;
  for (const cfg of Object.values(projects as Record<string, unknown>)) {
    const servers = (cfg as Record<string, unknown> | null)?.mcpServers as Record<string, unknown> | undefined;
    const entry = servers?.damc as Record<string, unknown> | undefined;
    if (entry && typeof entry === 'object') {
      entry.url = newUrl;
      updated++;
    }
  }
  if (!updated) return { ok: false, error: 'No damc server registered — run `damc ai setup claude --apply` first.' };
  return { ok: true, json: JSON.stringify(parsed.doc, null, 2) + '\n', updated };
}

// ---------------------------------------------------------------------------
// Skill installation content (pure)
// ---------------------------------------------------------------------------

/** Shared skill body, read from the same file the packs ship. */
export function readSkillBody(): string {
  return fs.readFileSync(path.join(REPO_ROOT, 'integrations', 'SKILL.md'), 'utf8');
}

/** Cursor project rule file. */
export function renderCursorRule(skillBody: string): string {
  return `---\ndescription: DAMC shared memory rules — every AI in this workspace reads and writes the same memory\nglobs:\n---\n\n${skillBody.trim()}\n`;
}

export const CLAUDE_MARK_START = '<!-- DAMC:START (shared memory rules — safe to re-run `damc ai skill claude --apply`) -->';
export const CLAUDE_MARK_END = '<!-- DAMC:END -->';

/** Snippet merged into a project's CLAUDE.md. */
export function renderClaudeSnippet(skillBody: string): string {
  return `${CLAUDE_MARK_START}\n\n${skillBody.trim()}\n\n${CLAUDE_MARK_END}`;
}

/** Idempotent merge: replaces the marked block, or appends it. Always ends with exactly one newline, so re-running reports up-to-date instead of churning backups. */
export function mergeClaudeMd(existing: string | null, snippet: string): string {
  const body = (existing ?? '').replace(/\s+$/, '');
  const start = body.indexOf(CLAUDE_MARK_START);
  const end = body.indexOf(CLAUDE_MARK_END);
  let core: string;
  if (start !== -1 && end !== -1 && end > start) {
    core = (body.slice(0, start) + snippet + body.slice(end + CLAUDE_MARK_END.length)).replace(/\s+$/, '');
  } else {
    core = body ? `${body}\n\n${snippet}` : snippet;
  }
  return `${core}\n`;
}

// ---------------------------------------------------------------------------
// Side effects (main only)
// ---------------------------------------------------------------------------

export interface SetupPlan {
  lines: string[];
  writeFile?: { path: string; content: string };
  runCommand?: { command: string; argv: string[] };
}

function backupPath(p: string): string {
  return `${p}.bak`;
}

function planWriteFile(target: string, content: string, apply: boolean, lines: string[]): void {
  const prev = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
  if (prev === content) {
    lines.push(`Up to date: ${target}`);
    return;
  }
  if (!apply) {
    lines.push(prev === null ? `Would create: ${target}` : `Would update: ${target} (current copy saved to ${backupPath(target)})`);
    return;
  }
  if (prev !== null) fs.writeFileSync(backupPath(target), prev);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  lines.push(prev === null ? `Created: ${target}` : `Updated: ${target} (previous copy at ${backupPath(target)})`);
}

function defaultCursorConfigPath(): string {
  return path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.cursor', 'mcp.json');
}

function projectDir(flag?: string): string {
  return path.resolve(flag ?? process.cwd());
}

async function fetchJson(url: string, headers: Record<string, string>): Promise<any> {
  // Manual timeout (not AbortSignal.timeout): the signal's internal timer can
  // outlive the request and crash process exit on Windows (libuv assertion).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    // Connection: close — undici would otherwise pool a keep-alive socket and
    // process.exit() below trips a libuv assertion on Windows while it drains.
    const res = await fetch(url, { headers: { ...headers, Connection: 'close' }, signal: controller.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 200)}` : ''}`);
    }
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

function renderPackText(pack: any): string {
  const lines = [
    `PROJECT: ${pack.project?.name ?? '(account-wide)'}`,
    `Generated: ${pack.generatedAt ?? ''}`,
    ''
  ];
  const section = (title: string, rows: any[]) => {
    lines.push(`${title} (${rows.length}):`);
    if (!rows.length) lines.push('  - (none)');
    for (const r of rows.slice(0, 12)) {
      const who = Array.isArray(r.providers) && r.providers.length ? ` [${r.providers.join(' + ')}]` : '';
      lines.push(`  - ${(r.content ?? r.title ?? '').slice(0, 200)}${who}`);
    }
    lines.push('');
  };
  section('ACTIVE DECISIONS', pack.activeDecisions ?? []);
  section('OPEN TASKS', pack.activeTasks ?? []);
  section('CONSTRAINTS', pack.constraints ?? []);
  return lines.join('\n').trim();
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

const USAGE = [
  'DAMC AI bridge',
  '  damc ai setup claude [--url URL] [--key KEY] [--apply]',
  '  damc ai setup cursor [--url URL] [--key KEY] [--project DIR] [--apply]',
  '  damc ai setup chatgpt|grok|perplexity [--url URL]',
  '  damc ai skill cursor|claude [--project DIR] [--apply]',
  '  damc ai context <project> [--url URL] [--key KEY]',
  '  damc ai repoint [--url URL] [--apply]',
  '  damc ai status [--url URL] [--key KEY]',
  '',
  'Without --apply every command is dry-run: it prints what would happen.'
].join('\n');

export interface ParsedCli {
  ok: boolean;
  message?: string;
  command?: string;
  sub?: string;
  positional?: string[];
  flags?: Record<string, string | boolean>;
}

export function parseCliArgs(argv: string[]): ParsedCli {
  const [command, sub, ...rest] = argv;
  if (!command) return { ok: false, message: USAGE };
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i]!;
    if (tok.startsWith('--')) {
      const eq = tok.indexOf('=');
      if (eq !== -1) flags[tok.slice(2, eq)] = tok.slice(eq + 1);
      else if (rest[i + 1] !== undefined && !rest[i + 1]!.startsWith('--')) flags[tok.slice(2)] = rest[++i]!;
      else flags[tok.slice(2)] = true;
    } else positional.push(tok);
  }
  return { ok: true, command, sub, positional, flags };
}

function flag(flags: Record<string, string | boolean>, name: string): string | undefined {
  const v = flags[name];
  return typeof v === 'string' && v ? v : undefined;
}

async function cmdSetup(provider: string, flags: Record<string, string | boolean>): Promise<{ exit: number; output: string }> {
  const lines: string[] = [];
  const baseUrl = resolveBaseUrl(flag(flags, 'url'));
  const key = resolveApiKey(flag(flags, 'key'));
  const apply = flags.apply === true;
  const p = provider.toLowerCase();

  if (p === 'claude') {
    if (!key) {
      lines.push(
        'No API key supplied — create one in DAMC → AI Connections → API keys, then re-run with --key.',
        '',
        'Exact command:',
        `  claude ${claudeAddArgv(baseUrl, null).join(' ')}`
      );
      return { exit: 0, output: lines.join('\n') };
    }
    const argv = claudeAddArgv(baseUrl, key);
    if (!apply) {
      lines.push('Would run:', `  claude ${argv.join(' ')}`, '', 'Re-run with --apply to register DAMC in Claude Code.');
      return { exit: 0, output: lines.join('\n') };
    }
    const r = spawnSync('claude', argv, { encoding: 'utf8', timeout: 60000 });
    if (r.error) return { exit: 1, output: `Could not run the Claude Code CLI: ${(r.error as Error).message}\nIs Claude Code installed and on PATH?` };
    if (r.status !== 0) return { exit: 1, output: `claude mcp add failed:\n${(r.stderr || r.stdout || '').trim()}` };
    lines.push(`Claude Code connected to ${baseUrl}/mcp.`, 'Verify inside Claude Code: "Use DAMC session_start for my project."');
    return { exit: 0, output: lines.join('\n') };
  }

  if (p === 'cursor') {
    // Global config by default; per-project .cursor/mcp.json with --project.
    const projectFlag = flag(flags, 'project');
    const target = projectFlag ? path.join(projectDir(projectFlag), '.cursor', 'mcp.json') : defaultCursorConfigPath();
    const merged = mergeMcpJson(fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null, 'damc', cursorServerEntry(baseUrl, key));
    if (!merged.ok) return { exit: 1, output: merged.error! };
    if (!key) lines.push('Note: no API key supplied — the config carries <YOUR_DAMC_API_KEY>. Create one in DAMC → AI Connections → API keys.');
    if (!apply || !merged.changed) {
      lines.push(merged.changed ? `Would write: ${target}` : `Up to date: ${target}`, '', merged.json!);
      if (!apply && merged.changed) lines.push('Re-run with --apply to write it (current file backed up first).');
      return { exit: 0, output: lines.join('\n') };
    }
    planWriteFile(target, merged.json!, true, lines);
    lines.push('Restart Cursor and approve the damc server. Verify: "Use DAMC session_start for my project."');
    return { exit: 0, output: lines.join('\n') };
  }

  if (p === 'chatgpt' || p === 'grok' || p === 'perplexity') {
    const details: Record<string, string[]> = {
      chatgpt: [
        `Connector URL: ${baseUrl}/mcp`,
        'ChatGPT → Settings → Apps & Connectors → Developer Mode → Create → paste the URL.',
        'Auth must be enforced at your proxy (ChatGPT connectors carry no API key).',
        'Capability: read + context. Write stays platform-limited — shown honestly, never faked.'
      ],
      grok: [
        `Server URL: ${baseUrl}/mcp  +  header  Authorization: Bearer ${key ?? KEY_PLACEHOLDER}`,
        'Register via xAI Remote MCP Tools (docs.x.ai) where your Grok tooling offers it.',
        'Status is limited: consumer Grok surfaces without MCP are not DAMC clients.'
      ],
      perplexity: [
        `Connector URL: ${baseUrl}/mcp  +  header  Authorization: Bearer ${key ?? KEY_PLACEHOLDER}`,
        'Perplexity → Settings → Connectors → Add custom remote connector.',
        'Status is limited: the consumer search product is not an MCP client.'
      ]
    };
    return { exit: 0, output: [`${p[0]!.toUpperCase()}${p.slice(1)} — manual connector step (this client has no local config file):`, '', ...details[p]!].join('\n') };
  }

  return { exit: 1, output: `Unknown provider "${provider}". Expected claude, cursor, chatgpt, grok or perplexity.\n\n${USAGE}` };
}

async function cmdSkill(client: string, flags: Record<string, string | boolean>): Promise<{ exit: number; output: string }> {
  const lines: string[] = [];
  const apply = flags.apply === true;
  const dir = projectDir(flag(flags, 'project'));
  const c = client.toLowerCase();
  let skill: string;
  try {
    skill = readSkillBody();
  } catch {
    return { exit: 1, output: 'Could not read integrations/SKILL.md — run from the DAMC project folder.' };
  }
  if (c === 'cursor') {
    const target = path.join(dir, '.cursor', 'rules', 'damc.mdc');
    if (!apply) {
      lines.push(`Would write: ${target}`, '', renderCursorRule(skill));
      lines.push('Re-run with --apply to write it.');
      return { exit: 0, output: lines.join('\n') };
    }
    planWriteFile(target, renderCursorRule(skill), true, lines);
    return { exit: 0, output: lines.join('\n') };
  }
  if (c === 'claude') {
    const target = path.join(dir, 'CLAUDE.md');
    const prev = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
    const next = mergeClaudeMd(prev, renderClaudeSnippet(skill));
    if (prev === next) return { exit: 0, output: `Up to date: ${target}` };
    if (!apply) return { exit: 0, output: `Would update: ${target}\n\n${next}` };
    planWriteFile(target, next, true, lines);
    return { exit: 0, output: lines.join('\n') };
  }
  return { exit: 1, output: `Unknown client "${client}". Expected cursor or claude.\n\n${USAGE}` };
}

function defaultClaudeJsonPath(): string {
  return path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.claude.json');
}

async function cmdRepoint(flags: Record<string, string | boolean>): Promise<{ exit: number; output: string }> {
  const lines: string[] = [];
  const apply = flags.apply === true;
  const baseUrl = resolveBaseUrl(flag(flags, 'url'));
  const headers = authHeaders(resolveApiKey(flag(flags, 'key')));
  // Without an explicit --url, ask the running DAMC for its current endpoint.
  let endpoint = flag(flags, 'url') ? `${baseUrl}/mcp` : null;
  if (!endpoint) {
    try {
      const state = await fetchJson(`${baseUrl}/v1/remote-access`, headers) as { endpoint?: string | null };
      if (!state?.endpoint) {
        return { exit: 1, output: 'DAMC reports no public endpoint. Enable Remote Access first (AI Connections → Remote Access), or pass --url.' };
      }
      endpoint = `${String(state.endpoint).replace(/\/+$/, '')}/mcp`;
    } catch (error) {
      return { exit: 1, output: `Could not read DAMC Remote Access state: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  const targets = [
    { label: 'Cursor', path: flag(flags, 'cursor-json') ?? defaultCursorConfigPath(), fn: repointCursorConfig },
    { label: 'Claude Code', path: flag(flags, 'claude-json') ?? defaultClaudeJsonPath(), fn: repointClaudeConfig }
  ];
  let failed = false;
  for (const t of targets) {
    if (!fs.existsSync(t.path)) {
      lines.push(`${t.label}: no config at ${t.path} — skipped.`);
      continue;
    }
    const prev = fs.readFileSync(t.path, 'utf8');
    const r = t.fn(prev, endpoint);
    if (!r.ok) {
      lines.push(`${t.label}: ${r.error}`);
      failed = true;
      continue;
    }
    if (r.json === prev) {
      lines.push(`${t.label}: already at ${endpoint}.`);
      continue;
    }
    if (!apply) {
      lines.push(`${t.label}: would re-point ${r.updated} server(s) to ${endpoint}.`);
      continue;
    }
    planWriteFile(t.path, r.json!, true, lines);
  }
  lines.push(apply ? 'Restart the AI apps so they pick up the new endpoint.' : 'Re-run with --apply to write (current files backed up first).');
  return { exit: failed ? 1 : 0, output: lines.join('\n') };
}

async function cmdContext(project: string, flags: Record<string, string | boolean>): Promise<{ exit: number; output: string }> {
  const baseUrl = resolveBaseUrl(flag(flags, 'url'));
  const headers = authHeaders(resolveApiKey(flag(flags, 'key')));
  try {
    const projects = await fetchJson(`${baseUrl}/v1/projects`, headers) as Array<{ id: string; name: string }>;
    const found = projects.find(x => x.name.toLowerCase() === project.toLowerCase());
    if (!found) {
      const names = projects.map(x => x.name).join(', ') || '(none)';
      return { exit: 1, output: `No project named "${project}". Available: ${names}` };
    }
    const pack = await fetchJson(`${baseUrl}/v1/context/pack?projectId=${encodeURIComponent(found.id)}`, headers);
    return { exit: 0, output: renderPackText(pack) };
  } catch (error) {
    return { exit: 1, output: `Could not read DAMC context: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function cmdStatus(flags: Record<string, string | boolean>): Promise<{ exit: number; output: string }> {
  const baseUrl = resolveBaseUrl(flag(flags, 'url'));
  const headers = authHeaders(resolveApiKey(flag(flags, 'key')));
  try {
    const health = await fetchJson(`${baseUrl}/health`, {});
    const tools = await fetchJson(`${baseUrl}/v1/connectors/mcp/tools`, headers).catch(() => null);
    const lines = [
      `DAMC: ${health?.service ?? 'unknown'} v${health?.version ?? '?'} (${baseUrl})`,
      `Gateway: ${baseUrl}/mcp — API key required`,
      tools ? `Tools: ${(tools.tools ?? []).length} (protocol ${tools.protocolVersion ?? '?'})` : 'Tools: unreachable (needs an API key outside dev mode)'
    ];
    return { exit: 0, output: lines.join('\n') };
  } catch (error) {
    return { exit: 1, output: `DAMC unreachable at ${baseUrl}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function runCli(argv: string[]): Promise<{ exit: number; output: string }> {
  const parsed = parseCliArgs(argv);
  if (!parsed.ok) return { exit: 1, output: parsed.message! };
  const { command, sub, positional = [], flags = {} } = parsed;
  if (command === 'ai' && sub === 'setup' && positional[0]) return cmdSetup(positional[0], flags);
  if (command === 'ai' && sub === 'skill' && positional[0]) return cmdSkill(positional[0], flags);
  if (command === 'ai' && sub === 'context' && positional[0]) return cmdContext(positional[0], flags);
  if (command === 'ai' && sub === 'repoint') return cmdRepoint(flags);
  if (command === 'ai' && sub === 'status') return cmdStatus(flags);
  return { exit: 1, output: USAGE };
}

async function main(): Promise<void> {
  const result = await runCli(process.argv.slice(2));
  process.stdout.write(result.output + '\n');
  process.exit(result.exit);
}

const invokedAsScript = process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsScript) {
  main().catch(error => {
    process.stderr.write(`DAMC AI bridge failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
