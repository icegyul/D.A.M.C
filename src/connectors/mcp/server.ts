/**
 * MCP JSON-RPC boundary.
 *
 * This is the surface every AI client shares. It is transport-agnostic and
 * client-agnostic on purpose: Claude Code, Cursor, Gemini, Grok and ChatGPT are
 * all just callers, and none of them gets its own memory. The handlers live in
 * tools.ts and delegate to the same engines the rest of DAMC uses.
 *
 * A malformed or hostile request must never take the server down, so everything
 * is validated and every failure is mapped to a JSON-RPC error response.
 */

import { z } from 'zod';
import { TOOLS, TOOLS_BY_NAME, SERVER_VERSION, ToolError } from './tools.js';
import { readClientIdentity, type ClientIdentity } from './types.js';
import { recordClientSeen, recordToolCall, projectIdFromArgs } from '../../services/mcp-activity-service.js';

export const MCP_PROTOCOL_VERSION = '2025-06-18';

/**
 * Protocol versions this server can speak. initialize() echoes the client's
 * version when we support it and falls back to our newest otherwise — that is
 * what lets older Streamable HTTP clients (2025-03-26) and current ones
 * (2025-06-18) both connect without either side guessing.
 */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26'] as const;

/** JSON-RPC 2.0 error codes. */
const RPC = {
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603
} as const;

const envelopeSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string().min(1).max(120),
  params: z.record(z.string(), z.unknown()).optional()
});

type JsonRpcId = string | number | null;

function ok(id: JsonRpcId, result: unknown) {
  return { jsonrpc: '2.0' as const, id, result };
}

function fail(id: JsonRpcId, code: number, message: string, data?: unknown) {
  return { jsonrpc: '2.0' as const, id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

export interface McpContext {
  userId: string;
  headers: Record<string, unknown>;
  /** Logger for internal failures; never receives request bodies. */
  logError?: (error: unknown, method: string) => void;
}

export function listTools() {
  return TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

/**
 * True when the POSTed message is a JSON-RPC notification (no id, method under
 * notifications/*). Per the Streamable HTTP transport, notifications are
 * answered with HTTP 202 and no body rather than a JSON-RPC response.
 */
export function isJsonRpcNotification(body: unknown): boolean {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false;
  const b = body as Record<string, unknown>;
  return b.id === undefined && typeof b.method === 'string' && b.method.startsWith('notifications/');
}

export function serverInfo(client: ClientIdentity) {
  return {
    name: 'damc',
    title: 'DAMC — Dalur AI Memory Center',
    version: SERVER_VERSION,
    description: 'Local-first shared memory layer. Every AI client reads and writes the same memory.',
    client: { id: client.id, version: client.version }
  };
}

/**
 * Handle one JSON-RPC message. Always resolves: transport-level problems are
 * returned as JSON-RPC errors rather than thrown.
 */
export async function handleMcpRequest(body: unknown, ctx: McpContext) {
  const parsed = envelopeSchema.safeParse(body);
  if (!parsed.success) {
    const rawId = (body as any)?.id;
    const id: JsonRpcId = typeof rawId === 'string' || typeof rawId === 'number' ? rawId : null;
    return fail(id, RPC.invalidRequest, 'Invalid JSON-RPC request', parsed.error.issues[0]?.message);
  }

  const { method, params } = parsed.data;
  const id: JsonRpcId = parsed.data.id ?? null;
  const client = readClientIdentity(ctx.headers, params?.clientInfo as any);

  try {
    switch (method) {
      case 'initialize': {
        // Negotiate: prefer the caller's version when we can speak it.
        const requested = typeof params?.protocolVersion === 'string' ? params.protocolVersion : undefined;
        const agreed = requested && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested) ? requested : MCP_PROTOCOL_VERSION;
        // A completed handshake is the "this client is configured" signal.
        void recordClientSeen(ctx.userId, client.id).catch(() => {});
        return ok(id, {
          protocolVersion: agreed,
          serverInfo: serverInfo(client),
          capabilities: { tools: { listChanged: false } }
        });
      }

      // Notifications carry no id and expect no result.
      case 'notifications/initialized':
      case 'initialized':
        return ok(id, {});

      case 'ping':
        return ok(id, {});

      case 'tools/list':
        return ok(id, { tools: listTools() });

      case 'tools/call': {
        const name = params?.name;
        if (typeof name !== 'string') return fail(id, RPC.invalidParams, 'tools/call requires a tool name');
        const tool = TOOLS_BY_NAME.get(name);
        if (!tool) {
          return fail(id, RPC.methodNotFound, `Unknown tool: ${name}`, { available: TOOLS.map(t => t.name) });
        }
        // Content-free activity audit (client, tool, outcome, project uuid) —
        // this is what grounds the Sync Center's real-connection statuses.
        // Never throws, and never logs names, queries, or content.
        void recordToolCall(ctx.userId, client.id, name, true, projectIdFromArgs(params?.arguments))
          .catch(() => {});
        const result = await tool.handler(ctx.userId, params?.arguments ?? {}, client);
        const payload = client.requestId ? { ...(result as object), requestId: client.requestId } : result;
        return ok(id, {
          content: [{ type: 'text', text: JSON.stringify(payload) }],
          structuredContent: payload
        });
      }

      default:
        return fail(id, RPC.methodNotFound, `Method not found: ${method}`);
    }
  } catch (error) {
    if (error instanceof ToolError) {
      // A bad argument or a missing row is the caller's problem, not a server fault.
      return fail(id, error.kind === 'not_found' ? RPC.invalidParams : RPC.invalidParams, error.message);
    }
    ctx.logError?.(error, method);
    // Never leak internals (SQL, paths, credentials) to the client.
    return fail(id, RPC.internal, 'Internal error while handling the request');
  }
}
