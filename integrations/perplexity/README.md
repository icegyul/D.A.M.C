# Perplexity ↔ DAMC

Same honesty as Grok: Perplexity's consumer search product does not connect to
third-party MCP servers today, so the status is **limited**. Perplexity
tooling/agents that do speak MCP (Streamable HTTP, custom headers) get the full
**Read/Write/Context** contract against the shared gateway.

## Setup (MCP-capable Perplexity tooling)

1. Create an API key: DAMC dashboard → AI Connections → API keys.
2. Register the server:

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

3. Verify: *"Use DAMC context_pack for <project>."*

## The realistic loop today

Perplexity answers questions; the knowledge worth keeping goes back into DAMC
through whatever MCP-capable agent you run it in (`memory_create`,
`session_save`) — or through any other connected AI. Capabilities here describe
the gateway contract, not a product commitment by Perplexity.
