# DAMC v0.3 Implementation Notes

v0.3 makes DAMC usable as a real shared-memory backend rather than only an import prototype.

## New endpoints
- `GET /v1/state` — rebuild Current State from active/confirmed memories.
- `GET /v1/state/cached` — read materialized state, rebuilding if absent.
- `POST /v1/memories/:id/link` — conservative token-overlap relation linking.
- `POST /v1/auth/api-keys` — create a bearer API key; the raw key is returned once.
- `POST /v1/mcp` — minimal JSON-RPC MCP boundary with `damc_context`.

## Authentication
- Development mode preserves `X-DAMC-User-Id` and demo user behavior.
- Production mode should use `Authorization: Bearer damc_...` API keys until a full session/OIDC layer is added.
- API keys are stored only as SHA-256 hashes.

## Retrieval
PostgreSQL FTS (`search_vector`) is now the primary retrieval path, with the previous substring search retained as a fallback. This is deliberately not called semantic search yet. pgvector is scheduled for v0.5.

## Provider policy
DAMC never scrapes ChatGPT/Claude cookies, passwords, browser storage, or private endpoints. Official exports and officially supported connector/app/MCP surfaces are the only provider integration paths.
