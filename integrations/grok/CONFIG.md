# Grok — copy-ready config

Status: **limited** (see README — no official Grok consumer product connects
to third-party MCP servers today). Wherever your xAI client, agent framework
or API tooling speaks MCP, this is the config.

## Endpoint

```
http://127.0.0.1:8787/mcp        (same-machine client)
https://<your-host>/mcp          (remote — Remote Access or DAMC_PUBLIC_URL)
```

- Header on every request: `Authorization: Bearer <YOUR_DAMC_API_KEY>`
- Transport: MCP Streamable HTTP (`POST` JSON-RPC)

## Config shape (MCP-generic Grok tooling)

```json
{
  "mcpServers": {
    "damc": {
      "url": "http://127.0.0.1:8787/mcp",
      "headers": { "Authorization": "Bearer <YOUR_DAMC_API_KEY>" }
    }
  }
}
```

For xAI's Remote MCP flow (https://docs.x.ai/developers/tools/remote-mcp),
register the server URL above with the same Bearer header.

## Steps

1. DAMC → AI Connections → API keys → **Create API Key** (e.g. `grok`).
2. Publish DAMC only if Grok runs off this machine (Remote Access toggle).
3. Register the tool server per the xAI docs.
4. Verify: *"Use DAMC active_decisions for <project>."*

Consumer Grok surfaces that expose no MCP are not DAMC clients — shown as a
platform limit, never as a fake connection.
