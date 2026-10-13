/**
 * The single place DAMC's own version is written in source.
 *
 * It used to be spelled out separately in src/connectors/mcp/tools.ts
 * (SERVER_VERSION, which MCP `initialize` reports to every AI client) and inline
 * in src/http/routes.ts (the /health payload). Three independent literals for one
 * number meant a release could ship a server whose health endpoint and whose MCP
 * handshake disagreed about what it was.
 *
 * Kept equal to package.json's "version" by tests/version.test.ts — bump both
 * together, the same convention AI_PACK_VERSION and integrations/PACK_VERSION
 * already follow.
 *
 * The AI setup-pack version (AI_PACK_VERSION in services/connector-status-service.ts)
 * is deliberately NOT this value: the integrations/ packs version independently of
 * the server.
 */
export const DAMC_VERSION = '1.2.0';
