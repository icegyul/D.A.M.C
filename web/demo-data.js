/**
 * Offline fallback dataset.
 *
 * Every object here has the exact shape of the corresponding DAMC API
 * response, so LIVE and DEMO render through identical page code. This data is
 * never written anywhere and is only served when the backend is unreachable.
 *
 * Deliberately empty rather than populated with sample content: a fabricated
 * project or memory is easy to mistake for something real on a quick glance
 * (this happened once, with an earlier version of this file that shipped
 * two named sample projects). An honest empty state — the same thing a
 * brand-new install looks like before anything is imported — cannot be
 * mistaken for real data. The UI still always labels this mode as DEMO.
 */

const USER = '00000000-0000-0000-0000-000000000001';

export const demoProjects = [];
export const demoMemories = [];
export const demoRelations = [];
export const demoSyncJobs = [];
export const demoMcpActivity = [];

export const demoWatcherStatus = {
  running: false, dir: 'C:\\DAMC_IMPORT', hostDir: 'C:\\DAMC_IMPORT', processedDir: 'C:\\DAMC_IMPORT\\processed', failedDir: 'C:\\DAMC_IMPORT\\failed',
  dirExists: false, startedAt: null, lastEvent: null, history: []
};

export const demoDashboard = {
  memory: { total: 0, active: 0, candidates: 0, superseded: 0, decisions: 0, activeDecisions: 0, tasks: 0, openTasks: 0 },
  projects: { total: 0 },
  conversations: { total: 0, providers: 0 },
  relations: { total: 0 },
  recentJobs: []
};

export function demoState(projectId) {
  return {
    version: 'damc-current-state-v1',
    generatedAt: new Date().toISOString(),
    userId: USER,
    projectId: projectId ?? null,
    decisions: [], rules: [], constraints: [], goals: [], openIssues: [], tasks: [], insights: [], questions: [],
    recentKnowledge: []
  };
}

export function demoGraph() {
  return { nodes: [], edges: [] };
}

export function demoMemoryDetail() {
  return null;
}

export function demoProvidersFacet() {
  return [];
}

export function demoMemoryList() {
  return [];
}

const AI_CAPS = {
  importHistory: true, incrementalSync: false, realtimePush: false, readAccountData: false, writeBack: false, requiresOfficialAuth: true,
  import: true, manualSync: true, autoSync: false, liveSync: false, contextExport: true, contextPush: false, oauth: false
};
const TOOL_CAPS = { importHistory: false, incrementalSync: false, realtimePush: false, readAccountData: false, writeBack: true, requiresOfficialAuth: false, import: false, manualSync: false, autoSync: false, liveSync: false, contextExport: false, contextPush: false, oauth: false };
const BACKUP_CAPS = { ...TOOL_CAPS, requiresOfficialAuth: true };

// The capability/policy text below describes what DAMC can actually do — it is
// not sample content, and stays the same whether or not a backend is
// reachable. Only per-user state (connected, lastActivity) is zeroed out here.

const GATEWAY_NOTE = 'Create an API key in the DAMC AI Connections screen first, then substitute it for <YOUR_DAMC_API_KEY>.';
const HUB_URL = 'http://localhost:8787/mcp';

export const demoRemoteAccess = {
  enabled: false, endpoint: null, source: null,
  tunnelAvailable: false, tunnelRunning: false, tunnelUrl: null, tunnelStartedAt: null, tunnelError: null,
  lastVerifiedAt: null, lastVerifyOk: null
};

const demoAiClients = [
  {
    provider: 'chatgpt', label: 'ChatGPT', status: 'limited', connectionStatus: 'NOT_CONFIGURED',
    capabilities: { read: true, write: false, update: false, context: true, session: true, liveSync: false, push: false },
    note: 'ChatGPT Developer Mode supports custom remote MCP connectors, but their authentication is OAuth-shaped and DAMC serves API keys — so ChatGPT connects through a proxy that injects the key (or wherever your build offers header auth). Read and context work once connected; write and update stay off until a key-carrying path exists. No fake write path is provided.',
    setup: { summary: 'Publish the gateway over HTTPS, then add the URL as a custom connector from ChatGPT Developer Mode.', steps: [] },
    config: { url: HUB_URL, authentication: 'terminated-at-proxy (ChatGPT connectors cannot carry API keys)' },
    docs: 'integrations/chatgpt/README.md', setupDoc: 'integrations/chatgpt/SETUP.md',
    activity: null, usage: null
  },
  {
    provider: 'claude', label: 'Claude', status: 'available', connectionStatus: 'NOT_CONFIGURED',
    capabilities: { read: true, write: true, update: true, context: true, session: true, liveSync: false, push: false },
    note: 'Full read/write/update/context/session through Claude Code (HTTP MCP with header auth). Claude Desktop works via the mcp-remote bridge. Claude.ai custom connectors authenticate with OAuth 2.1, which DAMC does not serve yet — use Claude Code or the Desktop bridge until then.',
    setup: { summary: 'One command in Claude Code, or the mcp-remote bridge for Claude Desktop. ' + GATEWAY_NOTE, steps: [] },
    config: { 'claude-code': `claude mcp add --transport http damc ${HUB_URL} --header "Authorization: Bearer <YOUR_DAMC_API_KEY>"` },
    docs: 'integrations/claude/README.md', setupDoc: 'integrations/claude/SETUP.md',
    activity: null, usage: null
  },
  {
    provider: 'grok', label: 'Grok', status: 'limited', connectionStatus: 'NOT_CONFIGURED',
    capabilities: { read: true, write: true, update: true, context: true, session: true, liveSync: false, push: false },
    note: 'Limited: no official Grok consumer product connects to third-party MCP servers today. Wherever an xAI client, agent framework or API tooling of yours speaks MCP (Streamable HTTP with custom headers), it gets the full read/write/update/context contract from the same gateway.',
    setup: { summary: 'Register the gateway as a Remote MCP tool in your Grok API/agent setup. ' + GATEWAY_NOTE, steps: [] },
    config: { mcpServers: { damc: { url: HUB_URL, headers: { Authorization: 'Bearer <YOUR_DAMC_API_KEY>' } } } },
    docs: 'integrations/grok/README.md', setupDoc: 'integrations/grok/SETUP.md',
    activity: null, usage: null
  },
  {
    provider: 'perplexity', label: 'Perplexity', status: 'limited', connectionStatus: 'NOT_CONFIGURED',
    capabilities: { read: true, write: true, update: true, context: true, session: true, liveSync: false, push: false },
    note: 'Perplexity officially supports custom remote connectors (help center), and MCP-capable Perplexity tooling gets the full read/write/context contract from the same gateway. The connector flow leans on OAuth-style registration, so a Bearer header may need the proxy path — same constraint as ChatGPT, same honest labeling.',
    setup: { summary: 'Add the gateway as a custom remote connector where your Perplexity build offers it. ' + GATEWAY_NOTE, steps: [] },
    config: { mcpServers: { damc: { url: HUB_URL, headers: { Authorization: 'Bearer <YOUR_DAMC_API_KEY>' } } } },
    docs: 'integrations/perplexity/README.md', setupDoc: 'integrations/perplexity/SETUP.md',
    activity: null, usage: null
  },
  {
    provider: 'cursor', label: 'Cursor', status: 'available', connectionStatus: 'NOT_CONFIGURED',
    capabilities: { read: true, write: true, update: true, context: true, session: true, liveSync: false, push: false },
    note: 'Full read/write/update/context/session. Cursor supports remote (HTTP) MCP servers with custom headers — copy the generated config below into ~/.cursor/mcp.json (global) or .cursor/mcp.json (project).',
    setup: { summary: 'Paste the generated config into ~/.cursor/mcp.json, restart Cursor, approve the server. ' + GATEWAY_NOTE, steps: [] },
    config: { mcpServers: { damc: { url: HUB_URL, headers: { Authorization: 'Bearer <YOUR_DAMC_API_KEY>' } } } },
    docs: 'integrations/cursor/README.md', setupDoc: 'integrations/cursor/SETUP.md',
    activity: null, usage: null
  }
];

export const demoConnectorStatus = {
  version: 'damc-connector-status-v3',
  aiPack: { version: '1.1.0' },
  note: 'Account-history sync uses only officially supported provider surfaces or official exports. No password/cookie scraping.',
  policy: "Historical data enters through the provider's official export file. DAMC never uses passwords, cookies, session tokens or private APIs.",
  watchFolder: { running: false, dir: 'C:\\DAMC_IMPORT' },
  gateway: { path: '/mcp', transport: 'streamable-http', auth: 'bearer', baseUrl: 'http://localhost:8787', url: HUB_URL, tools: 22, authRequired: true },
  aiClients: demoAiClients,
  providers: [
    {
      provider: 'chatgpt', label: 'ChatGPT', kind: 'ai_provider',
      capabilities: AI_CAPS, connected: false, connectedAt: null,
      channels: [
        { id: 'official_export', label: 'Official Export', state: 'available', detail: 'Upload conversations.json or the full export ZIP on the Import page.' },
        { id: 'watch_folder', label: 'Watch folder', state: 'available', detail: 'Drop an export into the watch folder (Import page) and it imports automatically. This is DAMC watching a local folder, not ChatGPT pushing anything.' },
        { id: 'mcp', label: 'MCP', state: 'available', detail: 'DAMC exposes POST /v1/mcp (JSON-RPC). An MCP-capable client can call context_pack / damc_context.' },
        { id: 'account_sync', label: 'Account history sync', state: 'not_available', detail: 'Realtime consumer-account history sync is not implemented and is not represented as connected.' }
      ],
      lastActivity: { at: null, summary: null }
    },
    {
      provider: 'claude', label: 'Claude', kind: 'ai_provider',
      capabilities: AI_CAPS, connected: false, connectedAt: null,
      channels: [
        { id: 'official_export', label: 'Official Export', state: 'available', detail: 'Upload conversations.json or the full export ZIP on the Import page.' },
        { id: 'watch_folder', label: 'Watch folder', state: 'available', detail: 'Drop an export into the watch folder (Import page) and it imports automatically. This is DAMC watching a local folder, not Claude pushing anything.' },
        { id: 'mcp', label: 'MCP', state: 'available', detail: 'DAMC exposes POST /v1/mcp (JSON-RPC). An MCP-capable client can call context_pack / damc_context.' },
        { id: 'account_sync', label: 'Account history sync', state: 'not_available', detail: 'Realtime consumer-account history sync is not implemented and is not represented as connected.' }
      ],
      lastActivity: { at: null, summary: null }
    },
    {
      provider: 'obsidian', label: 'Obsidian', kind: 'knowledge_tool',
      capabilities: TOOL_CAPS, connected: null, connectedAt: null,
      channels: [
        { id: 'markdown_export', label: 'Export / Local Knowledge', state: 'needs_configuration', detail: 'Set OBSIDIAN_VAULT_PATH to write into a vault. Without it, export falls back to DATA_DIR/obsidian.' },
        { id: 'two_way_sync', label: 'Two-way sync', state: 'not_available', detail: 'Reading edits back from a vault is not implemented.' }
      ],
      lastActivity: { at: null, summary: null }
    },
    {
      provider: 'github', label: 'GitHub', kind: 'backup',
      capabilities: BACKUP_CAPS, connected: null, connectedAt: null,
      channels: [
        { id: 'backup', label: 'Backup', state: 'needs_configuration', detail: 'Set GITHUB_BACKUP_ENABLED=true and GITHUB_BACKUP_REPO. Credentials come from the host git configuration, never from DAMC.' },
        { id: 'restore', label: 'Restore', state: 'not_available', detail: 'Restore from a backup repository is not implemented.' }
      ],
      lastActivity: { at: null, summary: null }
    }
  ]
};
