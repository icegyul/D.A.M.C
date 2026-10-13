# ChatGPT — copy-ready config

ChatGPT connects with a **connector URL only** — there is no JSON block and no
API-key field in ChatGPT's connector setup. Authentication must be enforced
**at your proxy** (ChatGPT cannot present the DAMC key itself).

## 1. Endpoint

```
https://<your-host>/mcp
```

- `<your-host>` = your Remote Access endpoint (DAMC → AI Connections →
  Remote Access) or your own `DAMC_PUBLIC_URL` host.
- The proxy in front of DAMC **must require** the DAMC API key:
  `Authorization: Bearer <YOUR_DAMC_API_KEY>`.
- Transport: MCP Streamable HTTP (`POST` JSON-RPC). No other path is needed.

## 2. Register

ChatGPT → Settings → Apps & Connectors → enable Developer Mode → Create →
paste the URL above.

## 3. Verify (read + context)

> "Use DAMC context_pack for <project>."

You should get active decisions, open tasks and constraints with provenance.

## 4. Capability truth

| READ | CONTEXT | WRITE | UPDATE | SESSION | LIVE SYNC | PUSH |
|---|---|---|---|---|---|---|
| ✓ | ✓ | ✕ platform-limited | ✕ platform-limited | ✓ (read side) | ✕ | ✕ |

Write stays off until your environment provides a key-carrying path. DAMC
never serves an unauthenticated endpoint to work around this.

## 5. History

Past ChatGPT conversations enter DAMC through the official export file
(Settings → Data controls → Export), on the Import page or via
`C:\DAMC_IMPORT` — independent of this connector.
