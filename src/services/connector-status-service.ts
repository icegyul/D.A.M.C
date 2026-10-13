import { env } from '../config/env.js';
import { query } from '../db/pool.js';
import { ChatGPTConnector } from '../connectors/chatgpt-connector.js';
import { ClaudeConnector } from '../connectors/claude-connector.js';
import { getConnectionStates } from './connector-connection-service.js';
import { getWatcherStatus } from './import-watch-service.js';
import { getRemoteAccessState } from './remote-access-service.js';
import { activityForProvider, getActivityByClient, type ClientActivity } from './mcp-activity-service.js';

/**
 * Reports what each integration can actually do right now.
 *
 * `available` means the path is implemented and reachable in this build.
 * `configured` means the operator has supplied the settings it needs.
 * Nothing here is reported as a live account connection: DAMC has no consumer
 * account session, and account-history sync is deliberately not implemented.
 */
export type ChannelState = 'available' | 'needs_configuration' | 'not_available';

export interface ConnectorChannel {
  id: string;
  label: string;
  state: ChannelState;
  detail: string;
}

export interface ConnectorStatus {
  provider: string;
  label: string;
  kind: 'ai_provider' | 'knowledge_tool' | 'backup';
  capabilities: ReturnType<ChatGPTConnector['capabilities']>;
  channels: ConnectorChannel[];
  lastActivity: { at: string | null; summary: string | null };
  /**
   * null for providers with no connect/disconnect concept (obsidian, github —
   * those are configured, not toggled). true/false for chatgpt/claude, backed
   * by the `connectors` table — never a live account session, see
   * ConnectorCapabilities.oauth (always false here) and connections.notice.
   */
  connected: boolean | null;
  connectedAt: string | null;
}

const EXPORT_ONLY_NOTE = 'Historical data enters through the provider\'s official export file. DAMC never uses passwords, cookies, session tokens or private APIs.';
const NO_ACCOUNT_SYNC = 'Realtime consumer-account history sync is not implemented and is not represented as connected.';

async function lastJob(userId: string, connector: string) {
  const r = await query<{ finishedAt: string | null; createdAt: string; status: string; stats: Record<string, unknown> }>(
    `SELECT finished_at AS "finishedAt", created_at AS "createdAt", status, stats
     FROM sync_jobs WHERE user_id=$1 AND connector=$2 ORDER BY created_at DESC LIMIT 1`, [userId, connector]);
  const row = r.rows[0];
  if (!row) return { at: null, summary: null };
  const imported = Number((row.stats as any)?.imported ?? 0);
  const created = Number((row.stats as any)?.memoriesCreated ?? 0);
  return {
    at: row.finishedAt ?? row.createdAt,
    summary: row.status === 'completed'
      ? `${imported} conversations · ${created} memories`
      : `last job ${row.status}`
  };
}

const NO_OBSIDIAN_TOGGLE = { importHistory: false, incrementalSync: false, realtimePush: false, readAccountData: false, writeBack: true, requiresOfficialAuth: false, import: false, manualSync: false, autoSync: false, liveSync: false, contextExport: false, contextPush: false, oauth: false };
const NO_GITHUB_TOGGLE = { importHistory: false, incrementalSync: false, realtimePush: false, readAccountData: false, writeBack: true, requiresOfficialAuth: true, import: false, manualSync: false, autoSync: false, liveSync: false, contextExport: false, contextPush: false, oauth: false };

// ---------------------------------------------------------------------------
// AI Connections — what each AI client can do against the DAMC gateway, and
// what it has actually done.
//
// Two distinct layers, and the UI renders both:
//   capabilities   — what the PLATFORM allows today (never inflated; a host
//                    that cannot carry credentials gets write:false)
//   connectionStatus — what THIS user's DAMC has actually seen:
//                    NOT_CONFIGURED (no API key yet) →
//                    CONFIGURED (a key exists, nothing seen yet) →
//                    AUTHENTICATED (handshake only, no tool calls yet) →
//                    READ_READY (reads/context seen, no writes yet) →
//                    WRITE_READY (writes seen, none in the last day) →
//                    ACTIVE (tool calls within the last day)
//                    A client that connected but never did anything stays at
//                    AUTHENTICATED — never ACTIVE.
//
// "Push" is defined as injecting messages into a provider's chat — no such API
// exists for consumer chat products, so it is false everywhere. The real path
// to the same experience is the client calling DAMC tools, which is the
// session/context capability below.
// ---------------------------------------------------------------------------

export interface AiClientGateway {
  provider: string;
  label: string;
  /**
   * How this AI reaches DAMC, for grouping on the AI Connections screen.
   * 'agent'   — an MCP client (Hermes, Cursor, Claude Code): full tool surface.
   * 'service' — a chat product reached through its own connector mechanism.
   * Grouping only; the status model and capabilities are identical for both.
   */
  kind: 'agent' | 'service';
  /** Platform reachability: 'available' = works today end to end; 'limited' = the path exists but the host has constraints. */
  status: 'available' | 'limited' | 'not_supported';
  /** THIS user's real connection state, grounded in API keys and audit activity. */
  connectionStatus: 'NOT_CONFIGURED' | 'CONFIGURED' | 'AUTHENTICATED' | 'READ_READY' | 'WRITE_READY' | 'ACTIVE' | 'ERROR' | 'NOT_SUPPORTED';
  capabilities: {
    read: boolean;
    write: boolean;
    update: boolean;
    context: boolean;
    session: boolean;
    /** Provider-initiated history sync — no consumer chat API offers this. */
    liveSync: boolean;
    /** Forcing messages into the provider's chat — deliberately not faked. */
    push: boolean;
  };
  /** Real, per-provider platform constraints behind the capability flags. */
  note: string;
  /** Korean rendering of `note`, shown by a Korean dashboard; English stays the fallback. */
  noteKo?: string;
  setup: { summary: string; steps: string[]; summaryKo?: string; stepsKo?: string[] };
  /** Copy-ready connection config. `<YOUR_DAMC_API_KEY>` is replaced by the dashboard when the user picks a key. */
  config: Record<string, unknown>;
  docs: string;
  setupDoc: string;
  /** Memories this provider's clients wrote through DAMC (provenance-based, all-time). */
  activity: { memories: number; lastAt: string | null } | null;
  /** Tool-call activity from the MCP audit trail: last read / write / context. */
  usage: ClientActivity | null;
}

/** Version of the AI setup packs in integrations/. Kept equal to
 * integrations/PACK_VERSION by tests/ai-cli.test.ts — bump both together. */
export const AI_PACK_VERSION = '1.1.0';

async function hasActiveApiKey(userId: string): Promise<boolean> {
  const r = await query<{ id: string }>(
    `SELECT id FROM api_keys WHERE user_id=$1 AND revoked_at IS NULL LIMIT 1`, [userId]);
  return r.rows.length > 0;
}

async function legacyMcpActivity(userId: string): Promise<Record<string, { memories: number; lastAt: string | null }>> {
  // MCP-written memories are recognizable two ways: direct tool writes carry
  // source_type='mcp_tool', conversation-shaped writes (memory_create,
  // session_save) carry sources.metadata.via in ('mcp','mcp_session').
  const r = await query<{ provider: string; total: string; lastAt: string | null }>(
    `SELECT s.provider, count(*)::text AS total, max(m.updated_at)::text AS "lastAt"
     FROM memories m JOIN sources s ON s.id = m.source_id
     WHERE m.user_id=$1 AND (s.source_type IN ('mcp_tool','mcp_session') OR s.metadata->>'via' IN ('mcp','mcp_session'))
     GROUP BY s.provider`, [userId]);
  const byProvider: Record<string, { memories: number; lastAt: string | null }> = {};
  for (const row of r.rows) byProvider[row.provider] = { memories: Number(row.total), lastAt: row.lastAt };
  return byProvider;
}

const ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Derive one provider's connection state from platform reachability, the
 * content-free MCP audit trail, and whether an API key exists.
 *
 * ACTIVE is recency (a tool call within the last day), not a flag. Below that,
 * READ_READY vs WRITE_READY records what the client has actually done: reads
 * (or context/session pulls) without any write yet, vs at least one write.
 * AUTHENTICATED is a handshake with no tool calls — "connected" but unused.
 * Exported for hermetic tests; the audit rows themselves are covered by the
 * database-backed suites.
 */
export function connectionStatusFor(
  platformStatus: 'available' | 'limited' | 'not_supported',
  usage: ClientActivity | null,
  keyExists: boolean
): AiClientGateway['connectionStatus'] {
  if (platformStatus === 'not_supported') return 'NOT_SUPPORTED';
  if (usage?.lastActivityAt) {
    const age = Date.now() - new Date(usage.lastActivityAt).getTime();
    if (age <= ACTIVE_WINDOW_MS) return 'ACTIVE';
    if (usage.lastWriteAt) return 'WRITE_READY';
    if (usage.lastReadAt || usage.lastContextAt || usage.lastSessionAt) return 'READ_READY';
    return 'AUTHENTICATED';
  }
  return keyExists ? 'CONFIGURED' : 'NOT_CONFIGURED';
}

/** The key placeholder every generated config carries; the dashboard substitutes a real key client-side. */
const KEY_PLACEHOLDER = '<YOUR_DAMC_API_KEY>';

function gatewayHeaders() {
  return { Authorization: `Bearer ${KEY_PLACEHOLDER}` };
}

const CLIENT_SETUP_NOTE = 'Create an API key in the DAMC AI Connections screen first, then substitute it for <YOUR_DAMC_API_KEY>.';

function aiClients(baseUrl: string): Array<Omit<AiClientGateway, 'connectionStatus' | 'activity' | 'usage'>> {
  const url = `${baseUrl}/mcp`;
  return [
    {
      // The one agent on this machine verified end to end: handshake, tools/list,
      // real read, real write, and a cross-session re-read, each confirmed in DAMC's
      // own audit trail rather than from the agent's own account of itself.
      provider: 'hermes',
      noteKo: 'Hermes Agent는 헤더 인증을 쓰는 Streamable HTTP MCP 클라이언트로 연결되므로 22개 도구 전체 — 읽기·쓰기·갱신·컨텍스트·세션 — 가 동작합니다. 호스트 쪽 설정 두 가지가 필수입니다. Hermes의 Tool Search 기본값 "auto"는 MCP 도구를 tool_search/tool_describe/tool_call 뒤로 접는데, 그 상태에서 자연어 질문에 DAMC 호출이 전혀 일어나지 않았으므로 tools.tool_search.enabled 를 "off" 로 두어야 합니다. 그리고 X-DAMC-Client 헤더를 보내야 이 화면이 Hermes를 이름으로 식별합니다 — MCP 핸드셰이크의 clientInfo는 initialize에만 실려 오기 때문입니다. 실시간 동기화와 푸시는 false입니다: Hermes가 스스로 턴을 시작하며 DAMC는 에이전트로 밀어넣지 않습니다.',
      kind: 'agent',
      label: 'Hermes',
      status: 'available',
      capabilities: { read: true, write: true, update: true, context: true, session: true, liveSync: false, push: false },
      note: 'Hermes Agent connects as an MCP client over Streamable HTTP with header auth, so the whole 22-tool surface works: read, write, update, context and session. Two host-side settings are load-bearing. Hermes\' Tool Search defaults to "auto", which collapses every MCP tool behind a tool_search/tool_describe/tool_call bridge — with 22 DAMC tools deferred, a natural-language question produced no DAMC call at all, so set tools.tool_search.enabled to "off". And DAMC can only name Hermes on this screen if the X-DAMC-Client header is sent: the MCP handshake carries clientInfo only on initialize, so without it every later call is filed as "unknown". liveSync and push stay false because Hermes initiates its own turns; DAMC never pushes into an agent.',
      setup: {
        summary: 'Add DAMC to Hermes\' mcp_servers block, keep the key in Hermes\' .env, turn Tool Search off, then restart the gateway. ' + CLIENT_SETUP_NOTE,
        summaryKo: 'Hermes의 mcp_servers 블록에 DAMC를 추가하고, 키는 Hermes의 .env에 두고, Tool Search를 끈 뒤 게이트웨이를 재시작합니다. 먼저 DAMC AI 연결 화면에서 API 키를 만들고 <YOUR_DAMC_API_KEY> 자리에 넣으세요.',
        stepsKo: [
          'DAMC AI 연결 화면에서 API 키를 만듭니다.',
          'Hermes의 .env 에 MCP_DAMC_API_KEY= 로 넣습니다 — config.yaml 에 키를 직접 적지 않습니다.',
          '아래 mcp_servers 블록을 Hermes의 config.yaml 에 추가합니다 (~/.hermes/config.yaml, Windows는 %LOCALAPPDATA%\\hermes\\config.yaml).',
          'tools.tool_search.enabled: "off" 를 추가합니다. 그래야 22개 DAMC 도구가 바로 호출됩니다.',
          '실행 중인 Hermes 게이트웨이가 있으면 재시작합니다 (hermes gateway restart) — 게이트웨이는 시작 시점의 설정을 계속 쓰므로 텔레그램·디스코드 세션이 옛 설정에 남습니다.',
          '확인: hermes mcp test damc 를 실행한 뒤, 과거에 대해 물어보고 이 화면에서 Hermes가 활성으로 바뀌는지 봅니다.'
        ],
        steps: [
          'Create an API key in the DAMC AI Connections screen.',
          'Put it in Hermes\' .env as MCP_DAMC_API_KEY — never a literal key in config.yaml.',
          'Add the mcp_servers block below to Hermes\' config.yaml (~/.hermes/config.yaml, or %LOCALAPPDATA%\\hermes\\config.yaml on Windows).',
          'Add tools.tool_search.enabled: "off" so the 22 DAMC tools stay directly callable.',
          'Restart any long-running Hermes gateway (hermes gateway restart) — a running gateway keeps its old config, so Telegram and Discord sessions would otherwise still use the bridge.',
          'Verify: hermes mcp test damc, then ask a question about the past and check this screen shows Hermes as ACTIVE.'
        ]
      },
      config: {
        'config.yaml': {
          mcp_servers: {
            damc: {
              url: 'http://127.0.0.1:8787/v1/mcp',
              headers: {
                Authorization: `Bearer \${MCP_DAMC_API_KEY}`,
                'X-DAMC-Client': 'hermes'
              },
              enabled: true
            }
          },
          tools: { tool_search: { enabled: 'off' } }
        },
        '.env': 'MCP_DAMC_API_KEY=' + KEY_PLACEHOLDER
      },
      docs: 'integrations/hermes/README.md',
      setupDoc: 'integrations/hermes/SETUP.md'
    },
    {
      provider: 'chatgpt',
      noteKo: 'ChatGPT 개발자 모드는 원격 MCP 커넥터를 지원하지만 인증이 OAuth 방식이고 DAMC는 API 키를 씁니다. 그래서 ChatGPT는 키를 넣어주는 프록시를 거쳐 연결됩니다(또는 헤더 인증을 지원하는 빌드). 연결되면 읽기와 컨텍스트가 동작하고, 쓰기·갱신은 키를 전달할 경로가 생기기 전까지 꺼져 있습니다. 가짜 쓰기 경로는 제공하지 않습니다.',
      kind: 'service',
      label: 'ChatGPT',
      status: 'limited',
      capabilities: { read: true, write: false, update: false, context: true, session: true, liveSync: false, push: false },
      note: 'ChatGPT Developer Mode supports custom remote MCP connectors, but their authentication is OAuth-shaped and DAMC serves API keys — so ChatGPT connects through a proxy that injects the key (or wherever your build offers header auth). Read and context work once connected; write and update stay off until a key-carrying path exists. No fake write path is provided.',
      setup: {
        summary: 'Publish the gateway over HTTPS, then add the URL as a custom connector from ChatGPT Developer Mode.',
        steps: [
          'Publish DAMC over HTTPS — Remote Access (cloudflared) below, or your own reverse proxy.',
          'Make sure the proxy enforces the API key (ChatGPT cannot send one itself).',
          'ChatGPT → Settings → Apps & Connectors → enable Developer Mode → Create → paste ' + url,
          'Ask ChatGPT to use DAMC: "Use DAMC context_pack for <project>."'
        ]
      },
      config: { url, authentication: 'terminated-at-proxy (ChatGPT connectors cannot carry API keys)' },
      docs: 'integrations/chatgpt/README.md',
      setupDoc: 'integrations/chatgpt/SETUP.md'
    },
    {
      provider: 'claude',
      noteKo: 'Claude Code(HTTP MCP + 헤더 인증)로 읽기·쓰기·갱신·컨텍스트·세션 전부 동작합니다. Claude Desktop은 mcp-remote 브리지로 연결합니다. Claude.ai 커스텀 커넥터는 OAuth 2.1 인증이라 DAMC가 아직 지원하지 않습니다 — 그때까지는 Claude Code 또는 Desktop 브리지를 쓰세요.',
      kind: 'agent',
      label: 'Claude',
      status: 'available',
      capabilities: { read: true, write: true, update: true, context: true, session: true, liveSync: false, push: false },
      note: 'Full read/write/update/context/session through Claude Code (HTTP MCP with header auth). Claude Desktop works via the mcp-remote bridge. Claude.ai custom connectors authenticate with OAuth 2.1, which DAMC does not serve yet — use Claude Code or the Desktop bridge until then.',
      setup: {
        summary: 'One command in Claude Code, or the mcp-remote bridge for Claude Desktop. ' + CLIENT_SETUP_NOTE,
        steps: [
          'Create an API key in the DAMC AI Connections screen.',
          'Claude Code: run the command shown in the config below.',
          'Claude Desktop: add the mcp-remote config below to claude_desktop_config.json and restart.',
          'Verify: ask Claude "Use DAMC session_start for my project."'
        ]
      },
      config: {
        'claude-code': `claude mcp add --transport http damc ${url} --header "Authorization: Bearer ${KEY_PLACEHOLDER}"`,
        'claude-desktop': { mcpServers: { damc: { command: 'npx', args: ['-y', 'mcp-remote', url, '--header', `Authorization: Bearer ${KEY_PLACEHOLDER}`] } } }
      },
      docs: 'integrations/claude/README.md',
      setupDoc: 'integrations/claude/SETUP.md'
    },
    {
      provider: 'grok',
      noteKo: '제한적: 현재 공식 Grok 소비자 제품은 외부 MCP 서버에 연결하지 않습니다. xAI 클라이언트·에이전트 프레임워크·API 도구 중 MCP(Streamable HTTP + 커스텀 헤더)를 말하는 것이 있다면 같은 게이트웨이로 전체 읽기·쓰기·갱신·컨텍스트를 씁니다. MCP가 없는 소비자 화면은 아직 DAMC 클라이언트가 아니며, 연결됨으로 표시하지 않습니다.',
      kind: 'service',
      label: 'Grok',
      status: 'limited',
      capabilities: { read: true, write: true, update: true, context: true, session: true, liveSync: false, push: false },
      note: 'Limited: no official Grok consumer product connects to third-party MCP servers today, so this is the same honesty as the Grok pack README. Wherever an xAI client, agent framework or API tooling of yours speaks MCP (Streamable HTTP with custom headers, see docs.x.ai → Remote MCP Tools), it gets the full read/write/update/context contract from the same gateway. Consumer surfaces without MCP are simply not DAMC clients yet — never shown as connected.',
      setup: {
        summary: 'Register the gateway as a Remote MCP tool in your Grok API/agent setup. ' + CLIENT_SETUP_NOTE,
        steps: [
          'Create an API key in the DAMC AI Connections screen.',
          'Follow docs.x.ai → Tools → Remote MCP with server URL ' + url,
          'Send the Authorization: Bearer <key> header with each request.',
          'Verify: "Use DAMC active_decisions for <project>."'
        ]
      },
      config: { mcpServers: { damc: { url, headers: gatewayHeaders() } } },
      docs: 'integrations/grok/README.md',
      setupDoc: 'integrations/grok/SETUP.md'
    },
    {
      provider: 'perplexity',
      noteKo: '제한적: Perplexity 소비자 제품은 외부 MCP 서버 연결을 제공하지 않습니다. MCP를 지원하는 Perplexity 기반 도구가 있다면 같은 게이트웨이로 연결됩니다. 없는 연결을 꾸며 표시하지 않습니다.',
      kind: 'service',
      label: 'Perplexity',
      status: 'limited',
      capabilities: { read: true, write: true, update: true, context: true, session: true, liveSync: false, push: false },
      note: 'Perplexity officially supports custom remote connectors (help center), and MCP-capable Perplexity tooling gets the full read/write/context contract from the same gateway. The connector flow leans on OAuth-style registration, so a Bearer header may need the proxy path — same constraint as ChatGPT, same honest labeling.',
      setup: {
        summary: 'Add the gateway as a custom remote connector where your Perplexity build offers it. ' + CLIENT_SETUP_NOTE,
        steps: [
          'Create an API key in the DAMC AI Connections screen.',
          'Perplexity → Settings → Connectors → Add custom remote connector → ' + url,
          'If the flow refuses headers, put the key in your proxy and keep /mcp behind it.',
          'Verify: "Use DAMC context_pack for <project>."'
        ]
      },
      config: { mcpServers: { damc: { url, headers: gatewayHeaders() } } },
      docs: 'integrations/perplexity/README.md',
      setupDoc: 'integrations/perplexity/SETUP.md'
    },
    {
      provider: 'cursor',
      noteKo: '읽기·쓰기·갱신·컨텍스트·세션 전부 동작합니다. Cursor는 커스텀 헤더를 쓰는 원격(HTTP) MCP 서버를 지원합니다 — 생성된 설정을 ~/.cursor/mcp.json(전역) 또는 .cursor/mcp.json(프로젝트)에 붙여넣으세요.',
      kind: 'agent',
      label: 'Cursor',
      status: 'available',
      capabilities: { read: true, write: true, update: true, context: true, session: true, liveSync: false, push: false },
      note: 'Full read/write/update/context/session. Cursor supports remote (HTTP) MCP servers with custom headers — copy the generated config into ~/.cursor/mcp.json (global) or .cursor/mcp.json (project).',
      setup: {
        summary: 'Paste the generated config into ~/.cursor/mcp.json, restart Cursor, approve the server. ' + CLIENT_SETUP_NOTE,
        steps: [
          'Create an API key in the DAMC AI Connections screen.',
          'Open ~/.cursor/mcp.json (global) or .cursor/mcp.json (per project).',
          'Merge the mcpServers block from the config below.',
          'Restart Cursor and approve the DAMC server when prompted.',
          'Verify: ask Cursor "Use DAMC session_start for my project."'
        ]
      },
      config: { mcpServers: { damc: { url, headers: gatewayHeaders() } } },
      docs: 'integrations/cursor/README.md',
      setupDoc: 'integrations/cursor/SETUP.md'
    }
  ];
}

export async function getConnectorStatus(userId: string, opts: { baseUrl?: string } = {}) {
  const [chatgptActivity, claudeActivity, connections, watcher, legacyActivity, usageByClient, keyExists, remoteAccess] = await Promise.all([
    lastJob(userId, 'chatgpt'), lastJob(userId, 'claude'), getConnectionStates(userId), getWatcherStatus(),
    legacyMcpActivity(userId), getActivityByClient(userId), hasActiveApiKey(userId),
    getRemoteAccessState(userId)
  ]);
  const obsidianConfigured = Boolean(env.OBSIDIAN_VAULT_PATH);
  const githubConfigured = Boolean(env.GITHUB_BACKUP_ENABLED && env.GITHUB_BACKUP_REPO);
  const baseUrl = (opts.baseUrl ?? env.DAMC_PUBLIC_URL ?? '').replace(/\/+$/, '') || 'http://localhost:8787';

  const providers: ConnectorStatus[] = [
    {
      provider: 'chatgpt',
      label: 'ChatGPT',
      kind: 'ai_provider',
      capabilities: new ChatGPTConnector().capabilities(),
      channels: [
        { id: 'official_export', label: 'Official Export', state: 'available', detail: 'Upload conversations.json or the full export ZIP on the Import page.' },
        { id: 'watch_folder', label: 'Watch folder', state: 'available', detail: 'Drop an export into the watch folder (Import page) and it imports automatically. This is DAMC watching a local folder, not ChatGPT pushing anything.' },
        { id: 'mcp', label: 'MCP', state: 'available', detail: 'DAMC exposes POST /v1/mcp (JSON-RPC). An MCP-capable client can call context_pack / damc_context.' },
        { id: 'account_sync', label: 'Account history sync', state: 'not_available', detail: NO_ACCOUNT_SYNC }
      ],
      lastActivity: chatgptActivity,
      connected: connections.chatgpt?.connected ?? false,
      connectedAt: connections.chatgpt?.connectedAt ?? null
    },
    {
      provider: 'claude',
      label: 'Claude',
      kind: 'ai_provider',
      capabilities: new ClaudeConnector().capabilities(),
      channels: [
        { id: 'official_export', label: 'Official Export', state: 'available', detail: 'Upload conversations.json or the full export ZIP on the Import page.' },
        { id: 'watch_folder', label: 'Watch folder', state: 'available', detail: 'Drop an export into the watch folder (Import page) and it imports automatically. This is DAMC watching a local folder, not Claude pushing anything.' },
        { id: 'mcp', label: 'MCP', state: 'available', detail: 'DAMC exposes POST /v1/mcp (JSON-RPC). An MCP-capable client can call context_pack / damc_context.' },
        { id: 'account_sync', label: 'Account history sync', state: 'not_available', detail: NO_ACCOUNT_SYNC }
      ],
      lastActivity: claudeActivity,
      connected: connections.claude?.connected ?? false,
      connectedAt: connections.claude?.connectedAt ?? null
    },
    {
      provider: 'obsidian',
      label: 'Obsidian',
      kind: 'knowledge_tool',
      capabilities: NO_OBSIDIAN_TOGGLE,
      channels: [
        {
          id: 'markdown_export',
          label: 'Export / Local Knowledge',
          state: obsidianConfigured ? 'available' : 'needs_configuration',
          detail: obsidianConfigured
            ? `Markdown + wikilinks are written to ${env.OBSIDIAN_VAULT_PATH}.`
            : 'Set OBSIDIAN_VAULT_PATH to write into a vault. Without it, export falls back to DATA_DIR/obsidian.'
        },
        { id: 'two_way_sync', label: 'Two-way sync', state: 'not_available', detail: 'Reading edits back from a vault is not implemented.' }
      ],
      lastActivity: { at: null, summary: null },
      connected: null,
      connectedAt: null
    },
    {
      provider: 'github',
      label: 'GitHub',
      kind: 'backup',
      capabilities: NO_GITHUB_TOGGLE,
      channels: [
        {
          id: 'backup',
          label: 'Backup',
          state: githubConfigured ? 'available' : 'needs_configuration',
          detail: githubConfigured
            ? `Backups are committed to ${env.GITHUB_BACKUP_REPO} (${env.GITHUB_BACKUP_BRANCH}).`
            : 'Set GITHUB_BACKUP_ENABLED=true and GITHUB_BACKUP_REPO. Credentials come from the host git configuration, never from DAMC.'
        },
        { id: 'restore', label: 'Restore', state: 'not_available', detail: 'Restore from a backup repository is not implemented.' }
      ],
      lastActivity: { at: null, summary: null },
      connected: null,
      connectedAt: null
    }
  ];

  return {
    version: 'damc-connector-status-v3',
    // Preserved for existing API consumers.
    chatgpt: new ChatGPTConnector().capabilities(),
    claude: new ClaudeConnector().capabilities(),
    note: 'Account-history sync uses only officially supported provider surfaces or official exports. No password/cookie scraping.',
    policy: EXPORT_ONLY_NOTE,
    // AI setup packs (integrations/<ai>/{README,SETUP,CONFIG,DAMC_SKILL}.md).
    // Versioned in integrations/PACK_VERSION; the test suite pins the two equal
    // so the Sync Center never describes a pack the files do not contain.
    aiPack: { version: AI_PACK_VERSION },
    providers,
    // The one real "automatic" mechanism DAMC has, and it is provider-agnostic
    // (filesystem watch, not a provider push) — reported once here rather than
    // duplicated as a fake per-provider autoSync capability.
    watchFolder: { running: watcher.running, dir: watcher.hostDir },
    // Remote MCP gateway + per-AI-client connection reality.
    gateway: {
      path: '/mcp',
      transport: 'streamable-http',
      auth: 'bearer',
      baseUrl,
      url: `${baseUrl}/mcp`,
      tools: 22,
      authRequired: true
    },
    remoteAccess,
    aiClients: aiClients(baseUrl).map(client => {
      const usage = activityForProvider(usageByClient, client.provider);
      return {
        ...client,
        connectionStatus: connectionStatusFor(client.status, usage, keyExists),
        activity: legacyActivity[client.provider] ?? null,
        usage
      };
    })
  };
}
