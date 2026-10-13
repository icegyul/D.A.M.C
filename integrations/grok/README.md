# Grok ↔ DAMC

DAMC does not fake a Grok integration. Today there is no official Grok consumer
product that connects to third-party MCP servers, so the honest status is
**limited**: wherever an xAI client, agent framework or API tooling of yours
speaks MCP (Streamable HTTP with custom headers), it gets the **full
Read/Write/Context** contract against the same gateway as every other AI. Where
it does not, there is no path — nothing here pretends otherwise.

## Setup (any MCP-capable Grok client)

1. Create an API key: DAMC dashboard → AI Connections → API keys.
2. Register the server in the client:

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

3. Verify: *"Use DAMC active_decisions for <project>."*

## If xAI ships native MCP support

No DAMC change is needed: the gateway already speaks the standard transport and
per-key auth. Update the capability note in the Sync Center at that point —
until then it stays honest.
