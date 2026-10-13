/**
 * DAMC API client.
 *
 * Endpoints below mirror src/http/routes.ts exactly, including the verbs the
 * backend actually uses (status change is PATCH; export/backup are POST).
 *
 * Two modes:
 *   live — every call goes to the backend.
 *   demo — reads are served from demo-data.js; writes are refused, never faked.
 */

import * as demo from './demo-data.js';

export class ApiError extends Error {
  constructor(message, { status = 0, code = null, details = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class DemoModeError extends Error {
  constructor(action = 'This action') {
    super(`${action} requires a live DAMC backend. Connect a backend in Settings to make real changes.`);
    this.name = 'DemoModeError';
    this.code = 'DEMO_MODE';
  }
}

const SETTINGS_KEY = 'damc.settings.v1';
const DEFAULT_SETTINGS = { baseUrl: '', apiKey: '', userId: '', theme: 'light', language: '' };

export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)); } catch { /* storage unavailable */ }
  return next;
}

/** Same-origin by default: the dashboard is served by the backend itself. */
function baseUrl() {
  const configured = (loadSettings().baseUrl ?? '').trim();
  return configured.replace(/\/+$/, '');
}

function authHeaders() {
  const s = loadSettings();
  const headers = {};
  if (s.apiKey.trim()) headers.Authorization = `Bearer ${s.apiKey.trim()}`;
  if (s.userId.trim()) headers['X-DAMC-User-Id'] = s.userId.trim();
  return headers;
}

export const connection = {
  // 'live'            the backend answered and this client can use it
  // 'unauthenticated' the backend is up but refuses us — a key is needed
  // 'offline'         the backend did not answer
  // 'demo'            sample mode, entered ONLY when explicitly asked for
  // 'unknown'         not probed yet
  mode: 'unknown',
  health: null,          // last successful /health payload
  reason: null,          // why the mode is not 'live'
  checkedAt: null
};

const DEMO_FLAG_KEY = 'damc.demo.v1';

/**
 * Is sample mode explicitly switched on?
 *
 * Explicit means explicit: `?demo=1` in the URL, or a flag this function stored
 * after seeing one. It is NOT entered because a health probe failed.
 *
 * That distinction is the whole point. Demo mode used to be the fallback for any
 * failed probe — a slow container on a fresh install, one timeout through a tunnel
 * — and in that state every read was served from demo-data.js while the page went
 * on looking like an ordinary dashboard. The data there is deliberately empty, so
 * nothing fictional was ever displayed, but "your database" and "a stand-in for
 * your database" must not be the same screen, and a product must never decide for
 * itself to show one in place of the other.
 */
export function demoRequested() {
  try {
    const params = new URLSearchParams(location.search);
    if (params.get('demo') === '1') { localStorage.setItem(DEMO_FLAG_KEY, '1'); return true; }
    if (params.get('demo') === '0') { localStorage.removeItem(DEMO_FLAG_KEY); return false; }
    return localStorage.getItem(DEMO_FLAG_KEY) === '1';
  } catch {
    return false;
  }
}

async function parseError(response) {
  let body = null;
  try { body = await response.json(); } catch { /* non-JSON error body */ }
  const message = body?.message || `${response.status} ${response.statusText}`;
  return new ApiError(message, { status: response.status, code: body?.error ?? null, details: body?.details ?? null });
}

async function request(path, { method = 'GET', body, formData, timeout = 20000, signal } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });
  try {
    const headers = { ...authHeaders() };
    let payload;
    if (formData) {
      payload = formData;
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const response = await fetch(`${baseUrl()}${path}`, { method, headers, body: payload, signal: controller.signal });
    if (!response.ok) throw await parseError(response);
    if (response.status === 204) return null;
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error?.name === 'AbortError') throw new ApiError('Request timed out.', { code: 'TIMEOUT' });
    throw new ApiError(error?.message ?? 'Network request failed.', { code: 'NETWORK' });
  } finally {
    clearTimeout(timer);
  }
}

function qs(params) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v === undefined || v === null || v === '') continue;
    usp.set(k, String(v));
  }
  const s = usp.toString();
  return s ? `?${s}` : '';
}

// ---------------------------------------------------------------------------
// Connection handling
// ---------------------------------------------------------------------------

/** Probe /health. Sets connection.mode to 'live' or 'demo'. Never throws. */
/**
 * Work out what this client can actually do, and say so honestly.
 *
 * /health alone is not enough to claim "connected": it is deliberately
 * unauthenticated, so it answers 200 on an install that will 401 every single data
 * call. The chip used to go green on that basis while every card on the page showed
 * UNAUTHORIZED — the dashboard contradicting itself about its own state.
 *
 * So when the backend says a credential is required, this follows up with a cheap
 * authenticated probe and reports 'unauthenticated' if that is refused. And on an
 * install that has never issued a key, it asks for the first one (see
 * firstRunBootstrap) rather than leaving the owner locked out of their own data.
 */
export async function detectConnection() {
  if (demoRequested()) {
    connection.mode = 'demo';
    connection.health = null;
    connection.reason = 'Sample mode was requested explicitly.';
    connection.checkedAt = new Date().toISOString();
    return { ...connection };
  }

  let health;
  try {
    health = await request('/health', { timeout: 6000 });
    if (!health?.ok) throw new ApiError('Backend responded without ok:true.', { code: 'BAD_HEALTH' });
  } catch (error) {
    connection.mode = 'offline';
    connection.health = null;
    connection.reason = error?.message ?? 'Backend unreachable.';
    connection.checkedAt = new Date().toISOString();
    return { ...connection };
  }

  connection.health = health;
  connection.reason = null;

  // Older backends have no `auth` block. Treating its absence as "no credential
  // needed" keeps this client working against them unchanged.
  const needsKey = health.auth?.required === true;
  if (!needsKey) {
    connection.mode = 'live';
    connection.checkedAt = new Date().toISOString();
    return { ...connection };
  }

  // Authentication is enforced and this browser has no key. Ask for one: the server
  // grants it only to a request from this machine, which is the same trust boundary
  // the old dev mode used, and the key it returns is labelled and revocable.
  //
  // Whenever there is no key, not only on a virgin install. Clearing browser storage
  // or opening DAMC in a second browser used to be unrecoverable — keys are hashed,
  // so there was nothing to paste back.
  if (!loadSettings().apiKey.trim()) {
    await claimLocalKey().catch(() => { /* reported through the probe below */ });
  }

  try {
    await request('/v1/projects', { timeout: 6000 });
    connection.mode = 'live';
    connection.reason = null;
  } catch (error) {
    connection.mode = error?.status === 401 ? 'unauthenticated' : 'offline';
    connection.reason = error?.message ?? 'Backend refused this client.';
  }
  connection.checkedAt = new Date().toISOString();
  return { ...connection };
}

/**
 * Ask the backend for an API key for this browser.
 *
 * The server decides whether this is allowed — it accepts an unauthenticated
 * bootstrap only from a request that originates on its own machine. The key is
 * stored in the same settings slot a pasted key uses, so everything downstream is
 * unchanged, and it appears on the Connections page where it can be revoked.
 */
export async function claimLocalKey() {
  const result = await request('/v1/auth/bootstrap', { method: 'POST', body: {}, timeout: 15000 });
  if (result?.key) saveSettings({ apiKey: result.key });
  return result;
}

/** Explicit connection test used by Settings. Returns the raw result. */
export async function testConnection() {
  const health = await request('/health', { timeout: 6000 });
  return health;
}

/**
 * Should reads come from the sample dataset?
 *
 * Only in explicit demo mode. It used to be `mode !== 'live'`, which meant every
 * transient failure quietly swapped the data source underneath the user.
 */
export function isDemo() { return connection.mode === 'demo'; }

/** Can this client actually call /v1? Everything that writes checks this. */
export function isLive() { return connection.mode === 'live'; }

function assertLive(action) {
  if (isDemo()) throw new DemoModeError(action);
  // Offline and unauthenticated are not demo mode, but they are not writable
  // either. Refusing here with the real reason beats letting the request go out to
  // fail with something less specific.
  if (connection.mode === 'unauthenticated') {
    throw new ApiError(`${action} needs an API key. Open Settings and paste one, or restart DAMC to claim the first key.`,
      { status: 401, code: 'UNAUTHORIZED' });
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getDashboard() {
  if (isDemo()) return demo.demoDashboard;
  return request('/v1/dashboard');
}

export async function getProjects() {
  if (isDemo()) return demo.demoProjects;
  return request('/v1/projects');
}

export async function getMemories(params = {}) {
  if (isDemo()) return demo.demoMemoryList(params);
  return request(`/v1/memories${qs(params)}`);
}

export async function getMemory(id) {
  if (isDemo()) {
    const detail = demo.demoMemoryDetail(id);
    if (!detail) throw new ApiError('Memory not found in demo dataset.', { status: 404, code: 'NOT_FOUND' });
    return detail;
  }
  return request(`/v1/memories/${encodeURIComponent(id)}`);
}

export async function getMemoryProviders() {
  if (isDemo()) return demo.demoProvidersFacet();
  return request('/v1/memories/providers');
}

export async function getCurrentState(projectId, { cached = true } = {}) {
  if (isDemo()) return demo.demoState(projectId);
  return request(`${cached ? '/v1/state/cached' : '/v1/state'}${qs({ projectId })}`);
}

export async function getGraph(projectId) {
  if (isDemo()) return demo.demoGraph(projectId);
  return request(`/v1/graph${qs({ projectId })}`);
}

export async function getSyncJobs(limit = 30) {
  if (isDemo()) return demo.demoSyncJobs;
  return request(`/v1/sync/jobs${qs({ limit })}`);
}

/**
 * Live progress of imports running on the server right now.
 *
 * Polled while an upload is in flight: the import POST does not return until the
 * whole export has been ingested, so this is the only way the page can show
 * shard and conversation progress instead of an indeterminate bar. Returns an
 * empty list once nothing is running — the durable record is on the job row.
 */
export async function getImportProgress() {
  if (isDemo()) return { active: [] };
  return request('/v1/import/progress', { timeout: 8000 });
}

export async function getWatcherStatus() {
  if (isDemo()) return demo.demoWatcherStatus;
  return request('/v1/import/watch/status');
}

export async function getConnectorStatus() {
  if (isDemo()) return demo.demoConnectorStatus;
  return request('/v1/connectors/capabilities');
}

/** Enables this provider's local pipeline (web upload / CLI / watch folder / MCP). Never an account session — see connections.notice. */
export async function connectProvider(provider) {
  assertLive('Connecting a provider');
  return request(`/v1/connectors/${encodeURIComponent(provider)}/connect`, { method: 'POST' });
}

export async function disconnectProvider(provider) {
  assertLive('Disconnecting a provider');
  return request(`/v1/connectors/${encodeURIComponent(provider)}/disconnect`, { method: 'POST' });
}

// API keys — the credentials AI clients present to the remote MCP gateway.
// The raw key is returned exactly once, at creation; the list only ever shows prefixes.
export async function listApiKeys() {
  if (isDemo()) return { keys: [] };
  return request('/v1/auth/api-keys');
}

export async function createApiKey(label) {
  assertLive('Creating an API key');
  return request('/v1/auth/api-keys', { method: 'POST', body: { label } });
}

export async function revokeApiKey(id) {
  assertLive('Revoking an API key');
  return request(`/v1/auth/api-keys/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// Remote Access — publish DAMC to cloud AI clients (managed cloudflared quick
// tunnel, or the operator's own DAMC_PUBLIC_URL reverse proxy).
export async function getRemoteAccess() {
  if (isDemo()) return demo.demoRemoteAccess;
  return request('/v1/remote-access');
}

export async function enableRemoteAccess() {
  assertLive('Enabling Remote Access');
  return request('/v1/remote-access/enable', { method: 'POST', timeout: 60000 });
}

export async function disableRemoteAccess() {
  assertLive('Disabling Remote Access');
  return request('/v1/remote-access/disable', { method: 'POST' });
}

export async function verifyRemoteAccess(endpoint) {
  assertLive('Verifying Remote Access');
  return request('/v1/remote-access/verify', { method: 'POST', body: { endpoint }, timeout: 20000 });
}

export async function getContext(query, projectId) {
  if (isDemo()) throw new DemoModeError('Context retrieval');
  return request(`/v1/context${qs({ q: query, projectId })}`);
}

export async function getContextPack(projectId) {
  if (isDemo()) throw new DemoModeError('Context pack retrieval');
  return request(`/v1/context/pack${qs({ projectId })}`);
}

export async function getMcpActivity(limit = 20) {
  if (isDemo()) return { activity: demo.demoMcpActivity };
  return request(`/v1/activity/mcp${qs({ limit })}`);
}

export async function getSkill() {
  if (isDemo()) throw new DemoModeError('Skill download');
  return request('/v1/connectors/skill');
}

// ---------------------------------------------------------------------------
// Writes — refused in demo mode rather than simulated
// ---------------------------------------------------------------------------

export async function setMemoryStatus(id, status, reason) {
  assertLive('Changing memory status');
  return request(`/v1/memories/${encodeURIComponent(id)}/status`, { method: 'PATCH', body: { status, ...(reason ? { reason } : {}) } });
}

export async function linkMemory(id, projectId) {
  assertLive('Building relations');
  return request(`/v1/memories/${encodeURIComponent(id)}/link`, { method: 'POST', body: projectId ? { projectId } : {} });
}

export async function createProject(name) {
  assertLive('Creating a project');
  return request('/v1/projects', { method: 'POST', body: { name } });
}

export async function previewImport(provider, file) {
  assertLive('Import preview');
  const form = new FormData();
  form.append('file', file, file.name);
  return request(`/v1/import/${encodeURIComponent(provider)}/preview`, { method: 'POST', formData: form, timeout: 120000 });
}

export async function importFile(provider, file) {
  assertLive('Import');
  const form = new FormData();
  form.append('file', file, file.name);
  return request(`/v1/import/${encodeURIComponent(provider)}/file`, { method: 'POST', formData: form, timeout: 600000 });
}

/**
 * Describe a Claude export manifest. Reads the JSON only — no export_url is
 * fetched, because using one destroys it.
 */
export async function previewClaudeManifest(file) {
  assertLive('Claude export preview');
  const form = new FormData();
  form.append('file', file, file.name);
  return request('/v1/import/claude/manifest/preview', { method: 'POST', formData: form, timeout: 60000 });
}

/**
 * Start fetching and importing the packages a manifest lists. Returns a jobId
 * immediately; progress comes from /v1/import/progress, because several
 * gigabytes of downloads is not something to hold a request open for.
 */
export async function startClaudeManifestImport(file) {
  assertLive('Claude export import');
  const form = new FormData();
  form.append('file', file, file.name);
  return request('/v1/import/claude/manifest', { method: 'POST', formData: form, timeout: 60000 });
}

/**
 * Describe a manifest DAMC has never seen, without sending it.
 *
 * The page has already parsed the file locally, so what goes to the server is the
 * package list plus a sha256 of each download URL. The hash is enough to recognise a
 * link DAMC has already used and cannot be turned back into one — which is how the
 * "already used" warning survives without the credential leaving this tab.
 */
export async function previewClaudePackagePlan(local) {
  assertLive('Claude export preview');
  const files = [];
  for (const entry of local.files) {
    files.push({
      category: entry.category,
      filename: entry.filename,
      part: typeof entry.part === 'number' ? entry.part : null,
      urlFingerprint: await sha256Hex(entry.export_url)
    });
  }
  return request('/v1/import/claude/manifest/plan/preview', {
    method: 'POST',
    body: { version: local.version ?? null, createdAt: local.createdAt ?? null, files },
    timeout: 20000
  });
}

/**
 * sha256 as lowercase hex, matching the server's fingerprintUrl.
 *
 * Returns null where SubtleCrypto is unavailable (a non-secure origin that is not
 * localhost). The preview then simply cannot say whether a link was already used,
 * which is a missing warning rather than a broken flow — and never a reason to send
 * the URL instead.
 */
async function sha256Hex(text) {
  try {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

/**
 * Open a browser-download session for a manifest.
 *
 * NOTE WHAT IS NOT SENT. Only category, filename and part go to the server. Every
 * export_url stays in this tab: it is a bearer credential for one download of the
 * user's entire history, and DAMC has no business writing it to a database that
 * the GitHub backup adapter copies elsewhere.
 */
export async function startClaudePackageSession(plan) {
  assertLive('Claude export session');
  return request('/v1/import/claude/manifest/session', {
    method: 'POST',
    body: {
      version: plan.version ?? null,
      createdAt: plan.createdAt ?? null,
      files: plan.files.map(f => ({ category: f.category, filename: f.filename, part: f.part ?? null }))
    },
    timeout: 30000
  });
}

export async function getClaudePackageSession(jobId) {
  if (isDemo()) return { session: null, watcher: null };
  return request(jobId
    ? `/v1/import/claude/manifest/session/${encodeURIComponent(jobId)}`
    : '/v1/import/claude/manifest/session', { timeout: 15000 });
}

/**
 * Tell the server the user just opened one package's link.
 *
 * The link itself is opened by this tab; this only records that it happened, so
 * the rule about single-use links lives in the state machine rather than in the
 * page's memory.
 */
export async function markClaudePackageOpened(jobId, packageId) {
  assertLive('Claude export download');
  return request(`/v1/import/claude/manifest/session/${encodeURIComponent(jobId)}/packages/${encodeURIComponent(packageId)}/open`,
    { method: 'POST', timeout: 15000 });
}

export async function getSyncJob(jobId) {
  if (isDemo()) return null;
  const jobs = await getSyncJobs(20);
  return (jobs ?? []).find(j => j.id === jobId) ?? null;
}

export async function startWatcher() {
  assertLive('Starting the watch folder');
  return request('/v1/import/watch/start', { method: 'POST' });
}

export async function stopWatcher() {
  assertLive('Stopping the watch folder');
  return request('/v1/import/watch/stop', { method: 'POST' });
}

export async function rebuildCurrentState(projectId) {
  assertLive('Rebuilding Current State');
  return request(`/v1/state${qs({ projectId })}`);
}

export async function exportJson() {
  assertLive('JSON export');
  return request('/v1/export/json', { method: 'POST', timeout: 120000 });
}

export async function getObsidianStatus() {
  if (isDemo()) {
    return { vaultPath: '', hostPath: '', folderExists: false, synced: false, lastSyncAt: null, noteCount: 0,
             targets: { memories: 0, decisions: 0, tasks: 0, relations: 0 } };
  }
  return request('/v1/export/obsidian/status');
}

export async function exportObsidian() {
  assertLive('Obsidian export');
  return request('/v1/export/obsidian', { method: 'POST', timeout: 120000 });
}

export async function backupGithub() {
  assertLive('GitHub backup');
  return request('/v1/backup/github', { method: 'POST', timeout: 300000 });
}
