# DAMC Product State — v0.4 (+ frontend real integration)

## Done
1. Canonical PostgreSQL memory store
2. Conversation/source/message provenance
3. Memory lifecycle and versions
4. Heuristic extraction from imported conversations
5. Project detection and project records
6. Full-text retrieval
7. Current State materialization
8. Relation graph API
9. ChatGPT/Claude official export JSON ingestion
10. ChatGPT/Claude export ZIP ingestion
11. Built-in web dashboard, connected to the real API end to end
    (dashboard, memory search/filter/detail, lifecycle status writes, current
    state, graph, connector status, file import with preview, sync history,
    settings) with an explicit LIVE/DEMO indicator and demo writes refused
12. API key authentication
13. MCP JSON-RPC boundary
14. Obsidian export
15. GitHub backup foundation
16. Docker deployment

## Intentionally not done
- Consumer-account password/cookie scraping
- Unofficial private APIs
- Silent full-history mirroring from consumer ChatGPT/Claude accounts
- Fully automatic semantic embedding generation
- Multi-tenant billing/subscription layer
- Production OAuth/SSO

## Next production hardening
- real auth / user sessions
- pgvector embeddings + hybrid reranking
- background queue and retry
- semantic relation extraction
- MCP Streamable HTTP transport
- encrypted secrets and audit controls
- two-way Obsidian sync
- GitHub restore UI
- billing and organization tenancy
