# ChatGPT ↔ DAMC

DAMC gives ChatGPT **Read** and **Context** today. **Write stays off** until a
key-carrying path exists — ChatGPT's connector setup has no API-key field, and
DAMC never runs an unauthenticated endpoint, so no fake "two-way" claim is made
here. The moment your environment provides an authenticated path (a proxy that
injects the key, or OpenAI adding credential support to connectors), the same
gateway serves write with zero DAMC-side changes.

## Setup (4 steps)

1. Create an API key: DAMC dashboard → AI Connections → API keys.
2. Publish the gateway over HTTPS so ChatGPT's backend can reach it:
   - reverse proxy (nginx/Caddy) in front of `127.0.0.1:8787`, **with the API
     key enforced at the proxy**, or
   - a tunnel (cloudflared/ngrok) — again, enforce auth at the tunnel.
   See `docs/REMOTE_MCP_GATEWAY.md` for the security notes.
3. ChatGPT → Settings → Connectors → **Add** → enter `https://<your-host>/mcp`
   (deep-research connectors, where your plan offers them).
4. Verify: *"Use DAMC to list the active decisions for <project>."*

## What ChatGPT can call

`memory_search`, `memory_get`, `project_memories`, `decision_search`,
`active_decisions`, `task_search`, `context_pack`, `damc_context`,
`server_info`, `health` — plus the write tools (`memory_create`,
`decision_create`, …) the moment the connection carries credentials.

## Getting history in

ChatGPT-side memory enters DAMC the same way it always has: the official
**Settings → Data controls → Export** file, dropped into the Import page or
`C:\DAMC_IMPORT`. That path is independent of the gateway and keeps working.
