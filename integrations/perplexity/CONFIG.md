# Perplexity — copy-ready config

Status: **limited** (see README — the consumer search product is not an MCP
client; MCP-capable Perplexity tooling is). Where a Bearer header is accepted
it connects directly, otherwise enforce the key at your proxy — exactly like
the ChatGPT path.

## Endpoint

```
https://<your-host>/mcp
```

- `<your-host>` = Remote Access endpoint or your `DAMC_PUBLIC_URL` host.
- Header (when the form accepts one):
  `Authorization: Bearer <YOUR_DAMC_API_KEY>`
- Transport: MCP Streamable HTTP (`POST` JSON-RPC)

## Config shape (MCP-capable Perplexity tooling)

```json
{
  "mcpServers": {
    "damc": {
      "url": "https://<your-host>/mcp",
      "headers": { "Authorization": "Bearer <YOUR_DAMC_API_KEY>" }
    }
  }
}
```

## Steps

1. DAMC → AI Connections → API keys → **Create API Key** (e.g. `perplexity`).
2. Publish DAMC over HTTPS (Remote Access toggle or own proxy).
3. Perplexity → Settings → Connectors → Add custom remote connector → URL.
4. Verify: *"Use DAMC context_pack for <project>."*

Research worth keeping goes back into DAMC through the same gateway
(`memory_create`, `session_save`) — with sources preserved.
