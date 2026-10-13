# DAMC Roadmap

## v0.3 — memory layer hardening
- PostgreSQL full-text retrieval + tolerant fallback
- Current State materialization and cache
- API-key authentication foundation
- Relation linking endpoint
- MCP JSON-RPC boundary for shared context
- Provider-specific official-export ingestion remains the historical-import path

## v0.4 — provider bridge
- Verify current OpenAI Apps/MCP capabilities against the user's plan
- Verify Anthropic MCP/connector capabilities
- Build official-only inbound/outbound connector adapters
- Add signed connector configuration and audit trail

## v0.5 — semantic memory
- pgvector extension
- embedding provider abstraction
- hybrid lexical + vector ranking
- chunking and re-embedding jobs
- semantic duplicate/conflict review

## v0.6 — production security
- real user/session auth
- row-level security
- secret rotation
- rate limiting
- background queue/retry
- encrypted connector credentials

## v0.7 — UI
- DAMC web dashboard
- memory inbox
- current state
- project view
- graph
- sync center
- export/backup/restore
